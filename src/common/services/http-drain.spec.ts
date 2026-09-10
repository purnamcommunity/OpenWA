import { closeHttpServerAndConnections, FORCE_CLOSE_AFTER_MS } from './http-drain';

/**
 * The behaviour under test is the one `server.close()` does not have: ending connections rather
 * than waiting for them. Every case here is a shape that hung in production.
 */
describe('closeHttpServerAndConnections', () => {
  const makeServer = () => ({
    closeIdleConnections: jest.fn(),
    closeAllConnections: jest.fn(),
  });

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('drops idle keep-alives immediately — they are pure waiting', async () => {
    const server = makeServer();
    await closeHttpServerAndConnections(server, async () => {});
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
  });

  it('leaves a prompt teardown alone', async () => {
    const server = makeServer();
    await closeHttpServerAndConnections(server, async () => {});
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it('destroys what is left when close() hangs, which is what an SSE stream does', async () => {
    const server = makeServer();
    let release!: () => void;
    const hanging = new Promise<void>(resolve => {
      release = resolve;
    });

    const done = closeHttpServerAndConnections(server, () => hanging);
    expect(server.closeAllConnections).not.toHaveBeenCalled();

    jest.advanceTimersByTime(FORCE_CLOSE_AFTER_MS);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);

    // Destroying the sockets is what lets the pending close() settle.
    release();
    await expect(done).resolves.toBeUndefined();
  });

  it('does not fail when the server offers neither method', async () => {
    await expect(closeHttpServerAndConnections({}, async () => {})).resolves.toBeUndefined();
    await expect(closeHttpServerAndConnections(null, async () => {})).resolves.toBeUndefined();
  });

  it('clears its timer once teardown settles, including on failure', async () => {
    const server = makeServer();
    await expect(
      closeHttpServerAndConnections(server, () => Promise.reject(new Error('teardown blew up'))),
    ).rejects.toThrow('teardown blew up');

    jest.advanceTimersByTime(FORCE_CLOSE_AFTER_MS * 2);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });
});
