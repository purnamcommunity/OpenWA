import { VoipAudioTokenService } from './voip-audio-token.service';

describe('VoipAudioTokenService', () => {
  it('redeems a minted token for its session exactly once', () => {
    const service = new VoipAudioTokenService();
    const { token } = service.mint('s1');

    expect(service.consume(token)).toBe('s1');
    // A used token must be worthless — one token, one connection.
    expect(service.consume(token)).toBeNull();
  });

  it('refuses a token it never minted', () => {
    const service = new VoipAudioTokenService();
    expect(service.consume('a'.repeat(64))).toBeNull();
  });

  it('refuses an expired token', () => {
    const service = new VoipAudioTokenService();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now);
      const { token, expiresInSeconds } = service.mint('s1');
      clock.mockReturnValue(now + expiresInSeconds * 1000 + 1);
      expect(service.consume(token)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('mints distinct tokens for the same session', () => {
    const service = new VoipAudioTokenService();
    expect(service.mint('s1').token).not.toBe(service.mint('s1').token);
  });
});
