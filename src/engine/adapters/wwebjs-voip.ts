import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Outgoing and answered calls on the whatsapp-web.js engine.
 *
 * WhatsApp Web carries a full VOIP stack, but it lives behind lazily-fetched chunks that a headless
 * session never loads on its own, so every symbol here is reached through `window.require(...)`
 * inside the page rather than off a `window.Store` global — this build exposes no such global.
 *
 * The stack is a per-page singleton: `WAWebCallCollection` holds one `pendingOutgoingCall` and one
 * active call, so a session carries exactly one call at a time. It also needs a real capture
 * device — `checkVoipDevicePermissions` gates the outgoing path — which is what the container's
 * PulseAudio source (VOIP_AUDIO_ENABLED, see docker-entrypoint.sh) exists to provide. Without it a
 * call is placed and connects carrying silence.
 */

/** Discriminated page results. A missing module is `unsupported` (501), a WhatsApp-side no is
 *  `refused` (403); neither is an exception, so a page-shape change reads as a clear message
 *  instead of an opaque evaluate failure. */
type PageOk<T> = { ok: true } & T;
type PageFail = { unsupported: string } | { refused: string };
type PageResult<T = Record<string, never>> = PageOk<T> | PageFail;

/** Page function: boot the VOIP stack. Runs the same chain the UI's call button does —
 *  `ensureVoipInitialized('call')` pulls the backend chunk and calls `initWAWebVoip`. */
function pageEnsureVoipReady(): Promise<PageResult> {
  const req = (name: string): Record<string, unknown> | undefined => {
    try {
      return (window as unknown as { require: (n: string) => Record<string, unknown> }).require(name);
    } catch {
      return undefined;
    }
  };
  const mod = req('WAWebEnsureVoipInited');
  const ensure = mod?.ensureVoipInitialized as ((trigger: string) => Promise<void>) | undefined;
  if (typeof ensure !== 'function') {
    return Promise.resolve({ unsupported: 'WAWebEnsureVoipInited.ensureVoipInitialized' });
  }
  return ensure('call').then(
    () => ({ ok: true }) as PageResult,
    (error: unknown) => {
      // VoipInitUnavailableError means the page must reload before VOIP can start — a restart
      // decision that belongs to the operator, not to a retry loop here.
      const name = (error as { name?: string })?.name ?? '';
      return name === 'VoipInitUnavailableError'
        ? { refused: 'VoIP initialization requires a page reload' }
        : { refused: `VoIP initialization failed: ${String(error)}` };
    },
  );
}

/** Page function: place a 1:1 call. `startWAWebVoipCall(wid, isVideo, callFromUi)` resolves once
 *  signalling is away; the id is read back from the collection because it returns none. */
function pagePlaceCall(arg: { chatId: string; isVideo: boolean }): Promise<PageResult<{ callId: string | null }>> {
  const req = (name: string): Record<string, unknown> | undefined => {
    try {
      return (window as unknown as { require: (n: string) => Record<string, unknown> }).require(name);
    } catch {
      return undefined;
    }
  };
  const startMod = req('WAWebVoipStartCall');
  const start = startMod?.startWAWebVoipCall as
    ((wid: unknown, isVideo: boolean, callFromUi: number) => Promise<void>) | undefined;
  const widFactory = req('WAWebWidFactory');
  const createWid = widFactory?.createWid as ((jid: string) => unknown) | undefined;
  const calls = req('WAWebCallCollection');
  if (typeof start !== 'function') return Promise.resolve({ unsupported: 'WAWebVoipStartCall.startWAWebVoipCall' });
  if (typeof createWid !== 'function') return Promise.resolve({ unsupported: 'WAWebWidFactory.createWid' });

  // The stack holds one call. Starting a second is silently ignored upstream ("outgoing call
  // already pending"), which would look like success, so it is refused here instead.
  if (calls?.pendingOutgoingCall != null) {
    return Promise.resolve({ refused: 'a call is already being placed on this session' });
  }
  if ((calls?.isInConnectedCall as boolean | undefined) === true) {
    return Promise.resolve({ refused: 'this session is already in a call' });
  }

  let wid: unknown;
  try {
    wid = createWid(arg.chatId);
  } catch (error) {
    return Promise.resolve({ refused: `not a callable id: ${String(error)}` });
  }

  // 0 = "not from the UI" in the call-origin enum the outgoing QPL logs.
  return start(wid, arg.isVideo, 0).then(
    () => {
      // Narrowed inline rather than through a shared helper: this function is serialized into the
      // page, so it cannot close over anything in this module.
      const active: unknown = calls?.lastActiveCall;
      const id =
        typeof active === 'object' && active !== null && typeof (active as { id?: unknown }).id === 'string'
          ? (active as { id: string }).id
          : null;
      return { ok: true, callId: id };
    },
    (error: unknown) => ({ refused: `WhatsApp refused the call: ${String(error)}` }),
  );
}

/**
 * Page function: answer or hang up through the VoIP stack interface — the same object the call
 * UI's accept and hang-up buttons drive.
 *
 * Neither call takes an id: the stack holds ONE call, so `acceptCall(withAudio, withVideo)` answers
 * whatever is ringing and `endCall(reason, true)` ends whatever is running. The id the caller asked
 * for is therefore checked against the collection's active call first — without that, answering a
 * stale id would silently answer a different call.
 */
function pageCallAction(arg: { action: 'accept' | 'end'; callId: string; withVideo: boolean }): Promise<PageResult> {
  const req = (name: string): Record<string, unknown> | undefined => {
    try {
      return (window as unknown as { require: (n: string) => Record<string, unknown> }).require(name);
    } catch {
      return undefined;
    }
  };
  const mod = req('WAWebVoipStackInterface');
  const get = mod?.getVoipStackInterface as (() => Promise<Record<string, unknown> | null>) | undefined;
  if (typeof get !== 'function') {
    return Promise.resolve({ unsupported: 'WAWebVoipStackInterface.getVoipStackInterface' });
  }
  return get().then(
    iface => {
      if (iface == null) return { refused: 'the VoIP stack is not running' };
      if (iface.type !== 'web') return { unsupported: `voip stack type ${String(iface.type)}` };

      if (arg.action === 'accept') {
        // The stack answers the call it holds, so make sure that is the one asked for.
        const active: unknown = req('WAWebCallCollection')?.activeCall;
        const activeId =
          typeof active === 'object' && active !== null && typeof (active as { id?: unknown }).id === 'string'
            ? (active as { id: string }).id
            : null;
        if (activeId !== null && activeId !== arg.callId) {
          return { refused: `call ${arg.callId} is no longer the ringing call` };
        }
        const accept = iface.acceptCall as ((withAudio: boolean, withVideo: boolean) => Promise<unknown>) | undefined;
        if (typeof accept !== 'function') return { unsupported: 'voipStackInterface.acceptCall' };
        // Answer unmuted; video only when the caller asked for it.
        return accept(true, arg.withVideo).then(
          () => ({ ok: true }) as PageResult,
          (e: unknown) => ({ refused: `accept failed: ${String(e)}` }),
        );
      }

      const end = iface.endCall as ((reason: number, notifyPeer: boolean) => Promise<unknown>) | undefined;
      if (typeof end !== 'function') return { unsupported: 'voipStackInterface.endCall' };
      // EndCallReason.Self — this side hung up. The trailing true tells the peer, which is what the
      // UI's own hang-up passes; without it the other end keeps ringing.
      const reasons = req('WAWebVoipSignalingEnums')?.EndCallReason as Record<string, number> | undefined;
      const self = typeof reasons?.Self === 'number' ? reasons.Self : 2;
      return end(self, true).then(
        () => ({ ok: true }) as PageResult,
        (e: unknown) => ({ refused: `end failed: ${String(e)}` }),
      );
    },
    (e: unknown) => ({ refused: `the VoIP stack could not be reached: ${String(e)}` }),
  );
}

interface EvaluatablePage {
  evaluate: <T, A>(fn: (arg: A) => T | Promise<T>, arg?: A) => Promise<T>;
  /** Puppeteer's context handle, used only to grant the microphone. */
  browserContext?: () => { overridePermissions?: (origin: string, perms: string[]) => Promise<void> };
}

/** The origin the session runs on — the only one the microphone is granted for. */
const WA_ORIGIN = 'https://web.whatsapp.com';

export class WwebjsVoip {
  constructor(private readonly host: WwebjsEngineHost) {}

  private page(): EvaluatablePage {
    const page = (this.host.getClient() as unknown as { pupPage?: EvaluatablePage }).pupPage;
    if (!page) {
      // A literal condition rather than an interpolated message: the parity fence keys throw sites
      // on their literal, and the detail belongs in logs anyway.
      throw new EngineNotSupportedError('voipCall(no page)');
    }
    return page;
  }

  /** Unwrap a page result, mapping the two failure shapes onto the errors the HTTP layer maps. */
  private unwrap<T>(result: PageResult<T>, context: string): PageOk<T> {
    if ('unsupported' in result) {
      // The missing symbol is logged rather than interpolated into the error: the parity fence
      // requires a literal, and a per-build symbol name would register as a pseudo-method anyway.
      this.host.logger.warn(
        `Calling is unavailable on this WhatsApp Web build: ${result.unsupported} is missing (during ${context}).`,
      );
      throw new EngineNotSupportedError('voipCall(module missing)');
    }
    if ('refused' in result) {
      throw new EngineRefusedError(result.refused);
    }
    return result;
  }

  private async run<T>(context: string, fn: (arg: never) => Promise<PageResult<T>>, arg?: unknown): Promise<PageOk<T>> {
    let result: PageResult<T>;
    try {
      result = await this.page().evaluate(fn, arg as never);
    } catch (error) {
      this.host.reportIfPageTransportError(error, context);
      throw error;
    }
    return this.unwrap(result, context);
  }

  /**
   * Boot the VOIP stack if it is not already running. Every call path needs this first, and it is
   * idempotent — an already-inited stack returns immediately. Kept separate from placeCall so an
   * operator can pay the (slow, chunk-fetching) first boot before a call rather than during one.
   */
  async ensureVoipReady(): Promise<void> {
    this.host.ensureReady();
    await this.grantMicrophone();
    await this.run('ensureVoipReady', pageEnsureVoipReady);
    this.host.logger.log('VoIP stack ready');
  }

  /**
   * Grant the microphone to WhatsApp Web over CDP.
   *
   * A headless profile answers the permission prompt with a denial nobody is there to override, so
   * `getUserMedia` fails `NotAllowedError` even once the container HAS a capture device — and
   * WhatsApp then aborts the call before signalling. The usual
   * `--use-fake-ui-for-media-stream` is unavailable here: the flag is absent from Debian's chromium
   * binary, so the grant has to come through the DevTools protocol instead.
   *
   * Best-effort: a build whose context cannot override permissions still reaches the call, which
   * then fails with WhatsApp's own device error rather than one invented here.
   */
  private async grantMicrophone(): Promise<void> {
    try {
      const context = this.page().browserContext?.();
      await context?.overridePermissions?.(WA_ORIGIN, ['microphone']);
    } catch (error) {
      this.host.logger.warn(`Could not grant the microphone to ${WA_ORIGIN}: ${String(error)}`);
    }
  }

  /** Place a 1:1 voice or video call. Resolves once the offer is away, not when it is answered. */
  async placeCall(chatId: string, isVideo: boolean): Promise<string | null> {
    this.host.ensureReady();
    this.host.ensureNotChannelRecipient(chatId);
    await this.ensureVoipReady();
    const result = await this.run<{ callId: string | null }>('placeCall', pagePlaceCall, { chatId, isVideo });
    this.host.logger.log(`Placed ${isVideo ? 'video' : 'voice'} call to ${chatId}`);
    return result.callId;
  }

  /**
   * Answer a ringing incoming call. The id must be one still live in the calls delegate's cache —
   * an unknown or expired id is a 404 rather than a page error, matching rejectCall.
   */
  async answerCall(callId: string, isLive: (callId: string) => boolean, withVideo = false): Promise<void> {
    this.host.ensureReady();
    if (!isLive(callId)) {
      throw new CallNotFoundError(callId);
    }
    await this.ensureVoipReady();
    await this.run('answerCall', pageCallAction, { action: 'accept', callId, withVideo });
    this.host.logger.log(`Answered call ${callId}`);
  }

  /** Hang up the call this session is on. */
  async endCall(callId: string): Promise<void> {
    this.host.ensureReady();
    await this.run('endCall', pageCallAction, { action: 'end', callId, withVideo: false });
    this.host.logger.log(`Ended call ${callId}`);
  }
}
