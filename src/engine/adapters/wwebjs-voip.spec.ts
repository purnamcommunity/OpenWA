import { WwebjsVoip } from './wwebjs-voip';
import { type WwebjsEngineHost } from './wwebjs-host';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';

/**
 * The page functions are executed for real against a stubbed `window.require`, rather than being
 * replaced by a mock: their whole job is to survive a WhatsApp Web build that moved or dropped a
 * module, and a mocked evaluate would test nothing about that.
 */

type Modules = Record<string, Record<string, unknown> | undefined>;

/** A page whose evaluate runs the function in-process with `window.require` served from `modules`. */
const pageWith = (modules: Modules, overridePermissions = jest.fn().mockResolvedValue(undefined)) => ({
  browserContext: () => ({ overridePermissions }),
  overridePermissions,
  evaluate: jest.fn(async (fn: (arg: unknown) => unknown, arg: unknown) => {
    const prev = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      require: (name: string) => {
        if (!(name in modules)) throw new Error(`Cannot find module ${name}`);
        return modules[name];
      },
    };
    try {
      return await fn(arg);
    } finally {
      (globalThis as { window?: unknown }).window = prev;
    }
  }),
});

const hostWith = (page: unknown): { host: WwebjsEngineHost; warn: jest.Mock } => {
  const warn = jest.fn();
  const host = {
    ensureReady: jest.fn(),
    getClient: () => ({ pupPage: page }) as never,
    logger: { log: jest.fn(), warn, error: jest.fn() } as never,
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    ensureNotChannelRecipient: jest.fn(),
  } as unknown as WwebjsEngineHost;
  return { host, warn };
};

/** The happy-path module set: VoIP inits, a wid can be built, nothing is already ringing. */
const readyModules = (over: Partial<Modules> = {}): Modules => ({
  WAWebEnsureVoipInited: { ensureVoipInitialized: jest.fn().mockResolvedValue(undefined) },
  WAWebVoipStartCall: { startWAWebVoipCall: jest.fn().mockResolvedValue(undefined) },
  WAWebWidFactory: { createWid: (jid: string) => ({ toString: () => jid }) },
  WAWebCallCollection: {
    pendingOutgoingCall: null,
    isInConnectedCall: false,
    lastActiveCall: { id: 'CALL1' },
    activeCall: { id: 'CALL1' },
  },
  WAWebVoipStackInterface: {
    getVoipStackInterface: jest.fn().mockResolvedValue({
      type: 'web',
      acceptCall: jest.fn().mockResolvedValue(undefined),
      endCall: jest.fn().mockResolvedValue(undefined),
      rejectCall: jest.fn().mockResolvedValue(undefined),
    }),
  },
  WAWebVoipSignalingEnums: { EndCallReason: { Unknown: 0, Timeout: 1, Self: 2 } },
  ...over,
});

/** The acceptCall spy on the stack interface the modules hand back. */
const acceptCallOf = async (mods: Modules): Promise<jest.Mock> => {
  const get = mods.WAWebVoipStackInterface!.getVoipStackInterface as () => Promise<Record<string, unknown>>;
  return (await get()).acceptCall as jest.Mock;
};

describe('WwebjsVoip.ensureVoipReady', () => {
  it('boots the stack through the same entry point the call button uses', async () => {
    const mods = readyModules();
    const { host } = hostWith(pageWith(mods));

    await expect(new WwebjsVoip(host).ensureVoipReady()).resolves.toBeUndefined();
    expect(mods.WAWebEnsureVoipInited!.ensureVoipInitialized).toHaveBeenCalledWith('call');
  });

  it('reports a build without the VoIP module as not-supported rather than crashing', async () => {
    const { host, warn } = hostWith(pageWith(readyModules({ WAWebEnsureVoipInited: undefined })));

    await expect(new WwebjsVoip(host).ensureVoipReady()).rejects.toBeInstanceOf(EngineNotSupportedError);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WAWebEnsureVoipInited.ensureVoipInitialized'));
  });

  it('surfaces a stack that needs a reload as a refusal, not as a retryable error', async () => {
    const err = Object.assign(new Error('reload'), { name: 'VoipInitUnavailableError' });
    const mods = readyModules({ WAWebEnsureVoipInited: { ensureVoipInitialized: () => Promise.reject(err) } });
    const { host } = hostWith(pageWith(mods));

    await expect(new WwebjsVoip(host).ensureVoipReady()).rejects.toThrow(/requires a page reload/);
  });
});

describe('WwebjsVoip.placeCall', () => {
  it('places the call and reads the id back off the collection', async () => {
    const mods = readyModules();
    const { host } = hostWith(pageWith(mods));

    await expect(new WwebjsVoip(host).placeCall('919876543210@c.us', false)).resolves.toBe('CALL1');
    expect(mods.WAWebVoipStartCall!.startWAWebVoipCall).toHaveBeenCalledWith(expect.anything(), false, 0);
  });

  it('passes the video flag through', async () => {
    const mods = readyModules();
    await new WwebjsVoip(hostWith(pageWith(mods)).host).placeCall('919876543210@c.us', true);

    expect(mods.WAWebVoipStartCall!.startWAWebVoipCall).toHaveBeenCalledWith(expect.anything(), true, 0);
  });

  it('returns null when the offer went out but no id was published yet', async () => {
    const mods = readyModules({
      WAWebCallCollection: { pendingOutgoingCall: null, isInConnectedCall: false, lastActiveCall: null },
    });

    await expect(new WwebjsVoip(hostWith(pageWith(mods)).host).placeCall('9@c.us', false)).resolves.toBeNull();
  });

  it('refuses a second call rather than letting the stack silently drop it', async () => {
    const mods = readyModules({
      WAWebCallCollection: { pendingOutgoingCall: { id: 'X' }, isInConnectedCall: false, lastActiveCall: null },
    });
    const { host } = hostWith(pageWith(mods));

    await expect(new WwebjsVoip(host).placeCall('9@c.us', false)).rejects.toBeInstanceOf(EngineRefusedError);
    expect(mods.WAWebVoipStartCall!.startWAWebVoipCall).not.toHaveBeenCalled();
  });

  it('refuses while a call is already connected', async () => {
    const mods = readyModules({
      WAWebCallCollection: { pendingOutgoingCall: null, isInConnectedCall: true, lastActiveCall: null },
    });

    await expect(new WwebjsVoip(hostWith(pageWith(mods)).host).placeCall('9@c.us', false)).rejects.toThrow(
      /already in a call/,
    );
  });

  it('reports an id WhatsApp will not build a wid from as a refusal', async () => {
    const mods = readyModules({
      WAWebWidFactory: {
        createWid: () => {
          throw new Error('bad jid');
        },
      },
    });

    await expect(new WwebjsVoip(hostWith(pageWith(mods)).host).placeCall('nope', false)).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });

  it('boots the VoIP stack before placing', async () => {
    const mods = readyModules();
    await new WwebjsVoip(hostWith(pageWith(mods)).host).placeCall('9@c.us', false);

    expect(mods.WAWebEnsureVoipInited!.ensureVoipInitialized).toHaveBeenCalled();
  });

  it('refuses a channel recipient before touching the page', async () => {
    const page = pageWith(readyModules());
    const { host } = hostWith(page);
    (host.ensureNotChannelRecipient as jest.Mock).mockImplementation(() => {
      throw new Error('channel');
    });

    await expect(new WwebjsVoip(host).placeCall('123@newsletter', false)).rejects.toThrow('channel');
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe('WwebjsVoip.answerCall', () => {
  it('answers unmuted and without video by default', async () => {
    const mods = readyModules();
    const { host } = hostWith(pageWith(mods));

    await expect(new WwebjsVoip(host).answerCall('CALL1', () => true)).resolves.toBeUndefined();
    // The stack answers the one call it holds, so acceptCall takes flags, never an id.
    expect(await acceptCallOf(mods)).toHaveBeenCalledWith(true, false);
  });

  it('answers with video when asked', async () => {
    const mods = readyModules();
    await new WwebjsVoip(hostWith(pageWith(mods)).host).answerCall('CALL1', () => true, true);
    expect(await acceptCallOf(mods)).toHaveBeenCalledWith(true, true);
  });

  it('refuses when the ringing call is no longer the one asked for', async () => {
    const mods = readyModules({
      WAWebCallCollection: { pendingOutgoingCall: null, isInConnectedCall: false, activeCall: { id: 'OTHER' } },
    });

    await expect(new WwebjsVoip(hostWith(pageWith(mods)).host).answerCall('CALL1', () => true)).rejects.toThrow(
      /no longer the ringing call/,
    );
  });

  it('reports an unknown or expired call as not-found without reaching the page', async () => {
    const page = pageWith(readyModules());
    const { host } = hostWith(page);

    await expect(new WwebjsVoip(host).answerCall('GONE', () => false)).rejects.toBeInstanceOf(CallNotFoundError);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('refuses when the VoIP stack is not running', async () => {
    const mods = readyModules({ WAWebVoipStackInterface: { getVoipStackInterface: () => Promise.resolve(null) } });

    await expect(new WwebjsVoip(hostWith(pageWith(mods)).host).answerCall('C', () => true)).rejects.toThrow(
      /not running/,
    );
  });
});

describe('WwebjsVoip.endCall', () => {
  it('hangs up with EndCallReason.Self and tells the peer', async () => {
    const endCall = jest.fn().mockResolvedValue(undefined);
    const mods = readyModules({
      WAWebVoipStackInterface: { getVoipStackInterface: () => Promise.resolve({ type: 'web', endCall }) },
    });

    await new WwebjsVoip(hostWith(pageWith(mods)).host).endCall('C');
    // Without the trailing true the other end keeps ringing.
    expect(endCall).toHaveBeenCalledWith(2, true);
  });

  it('falls back to the documented Self value when the build exposes no enum', async () => {
    const endCall = jest.fn().mockResolvedValue(undefined);
    const mods = readyModules({
      WAWebVoipStackInterface: { getVoipStackInterface: () => Promise.resolve({ type: 'web', endCall }) },
      WAWebVoipSignalingEnums: {},
    });

    await new WwebjsVoip(hostWith(pageWith(mods)).host).endCall('C');
    expect(endCall).toHaveBeenCalledWith(2, true);
  });

  it('reports a build with no endCall rather than silently leaving the call up', async () => {
    const mods = readyModules({
      WAWebVoipStackInterface: { getVoipStackInterface: () => Promise.resolve({ type: 'web' }) },
    });

    await expect(new WwebjsVoip(hostWith(pageWith(mods)).host).endCall('C')).rejects.toBeInstanceOf(
      EngineNotSupportedError,
    );
  });
});

describe('WwebjsVoip microphone grant', () => {
  it('grants the microphone to WhatsApp Web before booting the stack', async () => {
    const page = pageWith(readyModules());
    await new WwebjsVoip(hostWith(page).host).ensureVoipReady();

    // A headless profile denies the prompt with nobody there to override it, and Debian's chromium
    // has no --use-fake-ui-for-media-stream, so the grant must come over CDP.
    expect(page.overridePermissions).toHaveBeenCalledWith('https://web.whatsapp.com', ['microphone']);
  });

  it('still reaches the call when the context cannot grant permissions', async () => {
    const page = pageWith(readyModules(), jest.fn().mockRejectedValue(new Error('unsupported')));

    await expect(new WwebjsVoip(hostWith(page).host).ensureVoipReady()).resolves.toBeUndefined();
  });
});

describe('WwebjsVoip without a page', () => {
  it('reports a session with no page instead of dereferencing null', async () => {
    const { host } = hostWith(undefined);

    await expect(new WwebjsVoip(host).ensureVoipReady()).rejects.toBeInstanceOf(EngineNotSupportedError);
  });
});
