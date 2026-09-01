import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

/**
 * Single-use, short-lived tokens that let an operator's BROWSER open the audio socket directly,
 * without the gateway's API key ever reaching a page.
 *
 * The trusted backend (which holds the API key) mints a token for one session and hands it to the
 * browser; the browser presents it in the socket handshake. Consuming is destructive — a token
 * authenticates exactly one connection, so a leaked token that has been used is worthless, and a
 * reconnect needs a fresh mint. The TTL only has to outlive the handshake, not the call: once the
 * socket is up, the connection itself is the credential.
 *
 * In-memory on purpose: the gateway is a single process, and a token that dies with it is the
 * point — nothing to persist, nothing to leak at rest.
 */
const TOKEN_TTL_MS = 60_000;

@Injectable()
export class VoipAudioTokenService {
  private readonly tokens = new Map<string, { sessionId: string; expiresAt: number }>();

  mint(sessionId: string): { token: string; expiresInSeconds: number } {
    this.sweep();
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { sessionId, expiresAt: Date.now() + TOKEN_TTL_MS });
    return { token, expiresInSeconds: TOKEN_TTL_MS / 1000 };
  }

  /** Redeem a token: returns the session it was minted for and forgets it. Null for an unknown,
   *  expired, or already-used token — the caller cannot tell which, and must not be able to. */
  consume(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    this.tokens.delete(token);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.sessionId;
  }

  /** Expired tokens are only ever a handshake that never happened; sweep on mint keeps the map
   *  bounded without a timer to manage. */
  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token);
    }
  }
}
