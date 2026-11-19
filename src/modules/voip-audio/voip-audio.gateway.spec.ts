import type { Socket } from 'socket.io';
import { VoipAudioGateway } from './voip-audio.gateway';
import { VoipAudioService } from './voip-audio.service';
import { VoipAudioTokenService } from './voip-audio-token.service';
import { AuthService } from '../auth/auth.service';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

/** A socket.io client stand-in capturing what the gateway tells it. */
function fakeClient(auth: Record<string, string>) {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const client = {
    id: `client-${Math.random().toString(36).slice(2)}`,
    handshake: { auth, headers: {} as Record<string, string> },
    emitted,
    disconnected: false,
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    disconnect: () => {
      (client as { disconnected: boolean }).disconnected = true;
    },
  };
  return client as unknown as Socket & { emitted: typeof emitted; disconnected: boolean };
}

function gatewayWith(overrides?: {
  validKey?: boolean;
  key?: { allowedSessions?: string[] | null; allowedChats?: string[] | null };
  validation?: Promise<unknown>;
}) {
  // Kept as the plain mock object, not cast to VoipAudioService: assertions below reference
  // `audio.open`, and through the class type that is an unbound method reference rather than a spy.
  const audio = {
    open: jest.fn(),
    close: jest.fn(),
    writeMic: jest.fn().mockReturnValue(true),
  };
  const authService = {
    validateApiKey: jest.fn().mockImplementation(() => {
      if (overrides?.validation) return overrides.validation;
      if (overrides?.validKey === false) throw new Error('bad key');
      return Promise.resolve({ role: ApiKeyRole.OPERATOR, ...overrides?.key });
    }),
  } as unknown as AuthService;
  const tokens = new VoipAudioTokenService();
  const gateway = new VoipAudioGateway(audio as unknown as VoipAudioService, authService, tokens);
  return { gateway, audio, tokens };
}

const prevEnabled = process.env.VOIP_AUDIO_ENABLED;
beforeEach(() => {
  process.env.VOIP_AUDIO_ENABLED = 'true';
});
afterAll(() => {
  if (prevEnabled === undefined) delete process.env.VOIP_AUDIO_ENABLED;
  else process.env.VOIP_AUDIO_ENABLED = prevEnabled;
});

describe('VoipAudioGateway token handshake', () => {
  it('admits a minted token and binds the socket to its session', async () => {
    const { gateway, tokens, audio } = gatewayWith();
    const { token } = tokens.mint('s1');
    const client = fakeClient({ token });

    await gateway.handleConnection(client);
    expect(client.disconnected).toBe(false);
    expect(client.emitted.some(e => e.event === 'audio:ready')).toBe(true);

    // A token-authenticated start needs no sessionId — the token already names the session.
    await gateway.start(client, {});
    expect(audio.open).toHaveBeenCalledWith('s1', expect.any(Function));
  });

  it('refuses a start for a session the token was not minted for', async () => {
    const { gateway, tokens, audio } = gatewayWith();
    const { token } = tokens.mint('s1');
    const client = fakeClient({ token });
    await gateway.handleConnection(client);

    await gateway.start(client, { sessionId: 'other-session' });
    expect(audio.open).not.toHaveBeenCalled();
    expect(
      client.emitted.some(e => e.event === 'audio:error' && (e.payload as { code: string }).code === 'FORBIDDEN'),
    ).toBe(true);
  });

  it('rejects a reused token — one token buys one connection', async () => {
    const { gateway, tokens } = gatewayWith();
    const { token } = tokens.mint('s1');
    await gateway.handleConnection(fakeClient({ token }));

    const second = fakeClient({ token });
    await gateway.handleConnection(second);
    expect(second.disconnected).toBe(true);
    expect(second.emitted.some(e => e.event === 'audio:error')).toBe(true);
  });

  it('rejects a token it never minted', async () => {
    const { gateway } = gatewayWith();
    const client = fakeClient({ token: 'f'.repeat(64) });
    await gateway.handleConnection(client);
    expect(client.disconnected).toBe(true);
  });

  it('still admits the API key path, which may pick any session', async () => {
    const { gateway, audio } = gatewayWith();
    const client = fakeClient({ apiKey: 'owa_k1_test' });
    await gateway.handleConnection(client);
    expect(client.disconnected).toBe(false);

    await gateway.start(client, { sessionId: 'any-session' });
    expect(audio.open).toHaveBeenCalledWith('any-session', expect.any(Function));
  });

  it('treats a client presenting both credentials as the browser it claims to be', async () => {
    const { gateway, tokens, audio } = gatewayWith({ validKey: false });
    const { token } = tokens.mint('s1');
    // The invalid API key must not matter: the token wins and binds the session.
    const client = fakeClient({ token, apiKey: 'owa_k1_invalid' });
    await gateway.handleConnection(client);
    expect(client.disconnected).toBe(false);

    await gateway.start(client, { sessionId: 'other' });
    expect(audio.open).not.toHaveBeenCalled();
  });
});

describe('VoipAudioGateway handshake gating', () => {
  it('holds an audio:start sent before the key is validated, and refuses it when the key fails', async () => {
    let reject!: (e: Error) => void;
    const validation = new Promise((_, r) => {
      reject = r;
    });
    const { gateway, audio } = gatewayWith({ validation });
    const client = fakeClient({ apiKey: 'owa_k1_forged' });

    const connected = gateway.handleConnection(client);
    // socket.io has already told the client it is connected, and Nest has bound the handlers.
    const started = gateway.start(client, { sessionId: 'victim-session' });
    reject(new Error('bad key'));
    await connected;
    await started;

    expect(audio.open).not.toHaveBeenCalled();
    expect(client.disconnected).toBe(true);
  });

  it('refuses a start from a socket that never completed a handshake', async () => {
    const { gateway, audio } = gatewayWith();
    await gateway.start(fakeClient({}), { sessionId: 's1' });
    expect(audio.open).not.toHaveBeenCalled();
  });

  it('holds a session-restricted key to its sessions', async () => {
    const { gateway, audio } = gatewayWith({ key: { allowedSessions: ['s1'] } });
    const client = fakeClient({ apiKey: 'owa_k1_scoped' });
    await gateway.handleConnection(client);

    await gateway.start(client, { sessionId: 's2' });
    expect(audio.open).not.toHaveBeenCalled();
    await gateway.start(client, { sessionId: 's1' });
    expect(audio.open).toHaveBeenCalledWith('s1', expect.any(Function));
  });

  it('refuses a chat-restricted key at the handshake', async () => {
    const { gateway } = gatewayWith({ key: { allowedChats: ['123@c.us'] } });
    const client = fakeClient({ apiKey: 'owa_k1_chat' });
    await gateway.handleConnection(client);
    expect(client.disconnected).toBe(true);
  });

  it('keeps a token socket bound to its session after audio:stop', async () => {
    const { gateway, tokens, audio } = gatewayWith();
    const { token } = tokens.mint('s1');
    const client = fakeClient({ token });
    await gateway.handleConnection(client);
    await gateway.start(client, {});
    gateway.stop(client);
    audio.open.mockClear();

    await gateway.start(client, { sessionId: 'other' });
    expect(audio.open).not.toHaveBeenCalled();
  });
});
