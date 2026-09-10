import type { Server } from 'http';
import { createLogger } from './logger.service';

/**
 * How long in-flight requests get to finish once teardown starts, before whatever is left is
 * destroyed. Long enough for an ordinary request to complete, short enough that it cannot outlast an
 * orchestrator's kill deadline.
 */
export const FORCE_CLOSE_AFTER_MS = 5000;

const logger = createLogger('HttpDrain');

/**
 * Closes an HTTP server for shutdown and, crucially, **ends the connections it is holding**.
 *
 * `server.close()` alone does not do that. It stops accepting new connections and then *waits for
 * the existing ones to end by themselves* — and this server always has connections that never
 * will: SSE event streams held open for the life of a client, socket.io websockets, and a tunnel's
 * keep-alives. So a plain `app.close()` never resolves, teardown never runs, and the process is
 * still sitting there when the orchestrator's SIGKILL arrives.
 *
 * That kill is not a tidy end. It can catch a browser engine mid-write and corrupt its profile,
 * which for WhatsApp means the login is gone and only a fresh QR scan on the physical phone brings
 * it back. Measured before this existed: `docker stop --timeout 60` used the whole 60 seconds and
 * still exited 137.
 *
 * Idle keep-alives go at once, since they are pure waiting. Everything else gets
 * `FORCE_CLOSE_AFTER_MS` to finish on its own and is then destroyed.
 */
export async function closeHttpServerAndConnections(
  server: Partial<Pick<Server, 'closeIdleConnections' | 'closeAllConnections'>> | null | undefined,
  close: () => Promise<void>,
  forceAfterMs: number = FORCE_CLOSE_AFTER_MS,
): Promise<void> {
  // Optional-called throughout: a test double, or a Node older than 18.2, may have neither method,
  // and shutdown must not fail because it could not be hurried.
  server?.closeIdleConnections?.();

  const closing = close();
  const forced = setTimeout(() => {
    logger.warn('Connections still open after grace — destroying them so teardown can finish', {
      forceAfterMs,
    });
    server?.closeAllConnections?.();
  }, forceAfterMs);
  // Never hold the process open on its own account: if teardown finishes first this timer is all
  // that would be left, and it would delay the exit by exactly the grace it was meant to bound.
  forced.unref?.();

  try {
    await closing;
  } finally {
    clearTimeout(forced);
  }
}
