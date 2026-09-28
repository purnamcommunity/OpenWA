import { EventEmitter } from 'events';
import { type Client } from 'whatsapp-web.js';
import {
  FRESH_LINK_SYNC_CAP_MS,
  SYNC_PROGRESS_BINDING,
  WwebjsSyncTracker,
  judgeSyncSnapshot,
  watchSyncProgress,
  type WaSyncSnapshot,
} from './wwebjs-sync-progress';
import { readEngineSyncState } from '../sync-state';

const snapshot = (overrides: Partial<WaSyncSnapshot> = {}): WaSyncSnapshot => ({
  offline: { started: true, complete: true, progress: 100 },
  history: { incomplete: false, realProgress: null, inProgress: false, paused: false, pausedOut: false },
  recentHistoryComplete: false,
  ...overrides,
});
const history = (overrides: Partial<NonNullable<WaSyncSnapshot['history']>>): WaSyncSnapshot['history'] => ({
  incomplete: false,
  realProgress: null,
  inProgress: false,
  paused: false,
  pausedOut: false,
  ...overrides,
});

describe('judgeSyncSnapshot', () => {
  const T0 = 1_000_000;

  it('reads a restored line with nothing running as synced', () => {
    expect(judgeSyncSnapshot(snapshot(), null, T0)).toMatchObject({ state: 'synced', phase: null, progress: null });
  });

  it('reports a running offline catch-up first, with its percent', () => {
    const s = snapshot({
      offline: { started: true, complete: false, progress: 35 },
      history: history({ inProgress: true, realProgress: 10 }),
    });
    expect(judgeSyncSnapshot(s, null, T0)).toMatchObject({ state: 'syncing', phase: 'offline', progress: 35 });
  });

  it('does not count an offline resume that has not started as running', () => {
    const s = snapshot({ offline: { started: false, complete: false, progress: null } });
    expect(judgeSyncSnapshot(s, null, T0).state).toBe('synced');
  });

  it('reports a history sync the model has in progress, including a pause', () => {
    const s = snapshot({ history: history({ incomplete: true, inProgress: true, realProgress: 60, paused: true }) });
    expect(judgeSyncSnapshot(s, null, T0)).toMatchObject({
      state: 'syncing',
      phase: 'history',
      progress: 60,
      paused: true,
    });
  });

  it('is unknown without a snapshot, or when the history model is unreadable', () => {
    expect(judgeSyncSnapshot(null, null, T0).state).toBe('unknown');
    expect(judgeSyncSnapshot(snapshot({ history: null }), null, T0).state).toBe('unknown');
  });

  it('still reports a running offline catch-up when the history model is unreadable', () => {
    const s = snapshot({ offline: { started: true, complete: false, progress: 5 }, history: null });
    expect(judgeSyncSnapshot(s, null, T0)).toMatchObject({ state: 'syncing', phase: 'offline' });
  });

  // The model starts every page load idle, so right after a new link it reads "not in progress"
  // until the first history chunk lands. A line linked here waits for WhatsApp's confirmation.
  describe('a newly linked line', () => {
    const pending = { outcome: 'pending' as const, readyAt: T0 };

    it('counts as syncing history before the first chunk moves the model', () => {
      expect(judgeSyncSnapshot(snapshot(), pending, T0 + 1000)).toMatchObject({
        state: 'syncing',
        phase: 'history',
        progress: null,
        freshLinkOutcome: 'pending',
      });
    });

    it('is synced once the model reaches 100%', () => {
      const s = snapshot({ history: history({ realProgress: 100 }) });
      expect(judgeSyncSnapshot(s, pending, T0 + 1000)).toMatchObject({ state: 'synced', freshLinkOutcome: 'complete' });
    });

    it("is synced once WhatsApp's persisted status says the recent history is complete", () => {
      const s = snapshot({ recentHistoryComplete: true });
      expect(judgeSyncSnapshot(s, pending, T0 + 1000)).toMatchObject({ state: 'synced', freshLinkOutcome: 'complete' });
    });

    it('is unknown, not synced, once WhatsApp gives up on a silent phone', () => {
      const s = snapshot({ history: history({ pausedOut: true, paused: true }) });
      expect(judgeSyncSnapshot(s, pending, T0 + 1000)).toMatchObject({
        state: 'unknown',
        freshLinkOutcome: 'abandoned',
      });
    });

    it('is unknown once the cap passes with no confirmation', () => {
      expect(judgeSyncSnapshot(snapshot(), pending, T0 + FRESH_LINK_SYNC_CAP_MS - 1).state).toBe('syncing');
      expect(judgeSyncSnapshot(snapshot(), pending, T0 + FRESH_LINK_SYNC_CAP_MS)).toMatchObject({
        state: 'unknown',
        freshLinkOutcome: 'abandoned',
      });
    });

    it('lets a model in progress win over the cap', () => {
      const s = snapshot({ history: history({ incomplete: true, inProgress: true, realProgress: 70 }) });
      expect(judgeSyncSnapshot(s, pending, T0 + FRESH_LINK_SYNC_CAP_MS + 1)).toMatchObject({
        state: 'syncing',
        progress: 70,
      });
    });
  });

  it('never reads a missing persisted flag as a pending sync on a restored line', () => {
    expect(judgeSyncSnapshot(snapshot({ recentHistoryComplete: false }), null, T0).state).toBe('synced');
  });
});

/**
 * A stand-in for the WhatsApp Web page globals watchSyncProgress reads: the module registry behind
 * `window.require`, backed by event emitters so the subscriptions can be driven.
 */
function installFakeWaWeb(options: { missing?: string[] } = {}) {
  const model = Object.assign(new EventEmitter(), {
    incomplete: false,
    realProgress: null as number | null,
    remainingPausedSeconds: null as number | null,
  });
  const cmd = new EventEmitter();
  const offline = { init: true, complete: false, progress: 20 };
  type HistoryStatus = { recentCompleted?: boolean } | null;
  let historyStatus: HistoryStatus = null;
  const modules: Record<string, unknown> = {
    WAWebOfflineHandler: {
      OfflineMessageHandler: {
        hasInitOfflineResumeManager: () => offline.init,
        isResumeComplete: () => offline.complete,
        getOfflineDeliveryProgress: () => offline.progress,
      },
    },
    WAWebHistorySyncProgressModel: { getHistorySyncProgressModel: () => model },
    WAWebHistorySyncProgressGetters: {
      getInProgress: (m: typeof model) =>
        m.incomplete &&
        (m.realProgress == null || m.realProgress < 100) &&
        (m.remainingPausedSeconds == null || m.remainingPausedSeconds > 0),
      getPaused: (m: typeof model) => m.remainingPausedSeconds != null,
    },
    WAWebUserPrefsHistorySync: { getHistorySyncStatus: () => historyStatus },
    WAWebCmd: { Cmd: cmd },
  };
  const binding = jest.fn().mockResolvedValue(undefined);
  const win: Record<string, unknown> = {
    require: (id: string) => {
      if (options.missing?.includes(id) || !(id in modules)) throw new Error(`Requiring unknown module "${id}"`);
      return modules[id];
    },
    [SYNC_PROGRESS_BINDING]: binding,
  };
  (globalThis as unknown as { window: unknown }).window = win;
  return {
    model,
    cmd,
    offline,
    binding,
    win,
    setHistoryStatus: (s: HistoryStatus) => (historyStatus = s),
  };
}

describe('watchSyncProgress (in-page)', () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    jest.useRealTimers();
  });

  it('reads the offline resume, the history model and the persisted status', () => {
    const page = installFakeWaWeb();
    page.model.incomplete = true;
    page.model.realProgress = 30;
    page.setHistoryStatus({ recentCompleted: false });

    expect(watchSyncProgress(SYNC_PROGRESS_BINDING)).toEqual({
      offline: { started: true, complete: false, progress: 20 },
      history: { incomplete: true, realProgress: 30, inProgress: true, paused: false, pausedOut: false },
      recentHistoryComplete: false,
    });
  });

  it('reports an offline resume with no manager yet as not started, without calling its readers', () => {
    const page = installFakeWaWeb();
    page.offline.init = false;
    expect(watchSyncProgress(SYNC_PROGRESS_BINDING).offline).toEqual({
      started: false,
      complete: false,
      progress: null,
    });
  });

  it('marks a pause countdown that ran out', () => {
    const page = installFakeWaWeb();
    page.model.incomplete = true;
    page.model.remainingPausedSeconds = 0;
    expect(watchSyncProgress(SYNC_PROGRESS_BINDING).history).toMatchObject({
      inProgress: false,
      paused: true,
      pausedOut: true,
    });
  });

  it('reads only a literal recentCompleted === true as complete', () => {
    const page = installFakeWaWeb();
    page.setHistoryStatus({ recentCompleted: true });
    expect(watchSyncProgress(SYNC_PROGRESS_BINDING).recentHistoryComplete).toBe(true);
    page.setHistoryStatus(null);
    expect(watchSyncProgress(SYNC_PROGRESS_BINDING).recentHistoryComplete).toBe(false);
  });

  it('reports an unreadable module as null instead of throwing', () => {
    installFakeWaWeb({ missing: ['WAWebOfflineHandler', 'WAWebHistorySyncProgressModel'] });
    expect(watchSyncProgress(SYNC_PROGRESS_BINDING)).toMatchObject({ offline: null, history: null });
  });

  it('pushes one coalesced snapshot per second of model or offline events, subscribing once per document', () => {
    jest.useFakeTimers();
    const page = installFakeWaWeb();
    watchSyncProgress(SYNC_PROGRESS_BINDING);
    watchSyncProgress(SYNC_PROGRESS_BINDING); // same document: no second subscription

    expect(page.model.listenerCount('change:realProgress')).toBe(1);
    expect(page.cmd.listenerCount('offline_delivery_end_from_bridge')).toBe(1);

    page.model.realProgress = 50;
    page.model.emit('change:realProgress');
    page.cmd.emit('offline_progress_update_from_bridge');
    page.offline.complete = true;
    page.cmd.emit('offline_delivery_end_from_bridge');
    expect(page.binding).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    expect(page.binding).toHaveBeenCalledTimes(1);
    expect((page.binding.mock.calls as unknown[][])[0][0]).toMatchObject({
      offline: { complete: true },
      history: { realProgress: 50 },
    });

    page.model.emit('change:remainingPausedSeconds');
    jest.advanceTimersByTime(1000);
    expect(page.binding).toHaveBeenCalledTimes(2);
  });
});

describe('WwebjsSyncTracker', () => {
  const logger = { debug: jest.fn(), warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  type FakePage = { exposeFunction: jest.Mock; evaluate: jest.Mock };
  const newClient = (page: Partial<FakePage> | null): Client => ({ pupPage: page }) as unknown as Client;
  const newPage = (first: unknown = snapshot()): FakePage => ({
    exposeFunction: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(first),
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const pushed = (page: FakePage) =>
    (page.exposeFunction.mock.calls as unknown[][])[0][1] as (snapshot: unknown) => void;

  it('is null until armed, and reports the first snapshot once installed', async () => {
    let current: Client | null = null;
    const tracker = new WwebjsSyncTracker({ logger: logger as never, sessionId: 's', isCurrent: c => c === current });
    expect(tracker.getState()).toBeNull();

    const page = newPage();
    current = newClient(page);
    tracker.arm(current, false);
    await flush();

    expect(page.exposeFunction).toHaveBeenCalledWith(SYNC_PROGRESS_BINDING, expect.any(Function));
    expect(page.evaluate).toHaveBeenCalledWith(watchSyncProgress, SYNC_PROGRESS_BINDING);
    expect(tracker.getState()).toMatchObject({ state: 'synced', phase: null });
  });

  it('follows pushed snapshots and stamps updatedAt only on a change', async () => {
    jest.useFakeTimers({ now: 10_000, doNotFake: ['setImmediate'] });
    try {
      const page = newPage(snapshot({ offline: { started: true, complete: false, progress: 10 } }));
      const client = newClient(page);
      const tracker = new WwebjsSyncTracker({ logger: logger as never, sessionId: 's', isCurrent: c => c === client });
      tracker.arm(client, false);
      await flush();
      const first = tracker.getState();
      expect(first).toMatchObject({ state: 'syncing', phase: 'offline', progress: 10 });

      jest.setSystemTime(20_000);
      pushed(page)(snapshot({ offline: { started: true, complete: false, progress: 10 } }));
      expect(tracker.getState()?.updatedAt).toBe(first?.updatedAt);

      jest.setSystemTime(30_000);
      pushed(page)(snapshot());
      expect(tracker.getState()).toMatchObject({ state: 'synced', updatedAt: new Date(30_000).toISOString() });
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops snapshots from a client that is no longer current, and anything malformed', async () => {
    let live = true;
    const page = newPage(snapshot());
    const client = newClient(page);
    const tracker = new WwebjsSyncTracker({ logger: logger as never, sessionId: 's', isCurrent: () => live });
    tracker.arm(client, false);
    await flush();

    pushed(page)({ nonsense: true });
    expect(tracker.getState()?.state).toBe('synced');

    live = false;
    pushed(page)(snapshot({ offline: { started: true, complete: false, progress: 1 } }));
    expect(tracker.getState()?.state).toBe('synced');
  });

  it('keeps a newly linked line syncing across a re-arm on the same client, exposing the binding once', async () => {
    const page = newPage(snapshot());
    const client = newClient(page);
    const tracker = new WwebjsSyncTracker({ logger: logger as never, sessionId: 's', isCurrent: c => c === client });
    tracker.arm(client, true);
    await flush();
    expect(tracker.getState()).toMatchObject({ state: 'syncing', phase: 'history' });

    // A navigation re-inject re-arms: the new document needs its listeners, the binding survives.
    tracker.arm(client, false);
    await flush();
    expect(page.exposeFunction).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(tracker.getState()?.state).toBe('syncing');

    pushed(page)(snapshot({ history: history({ realProgress: 100 }) }));
    expect(tracker.getState()?.state).toBe('synced');
    // Latched: the model dropping back to idle later does not reopen the wait.
    pushed(page)(snapshot());
    expect(tracker.getState()?.state).toBe('synced');
  });

  it('stays unknown on a page it cannot watch, and never evaluates there', async () => {
    const evaluate = jest.fn();
    const client = newClient({ evaluate });
    const tracker = new WwebjsSyncTracker({ logger: logger as never, sessionId: 's', isCurrent: () => true });
    tracker.arm(client, false);
    await flush();

    expect(evaluate).not.toHaveBeenCalled();
    expect(tracker.getState()?.state).toBe('unknown');
  });

  it('stays unknown when the install fails, and logs it at debug', async () => {
    const page = newPage();
    page.evaluate.mockRejectedValue(new Error('Execution context was destroyed'));
    const client = newClient(page);
    const tracker = new WwebjsSyncTracker({ logger: logger as never, sessionId: 's', isCurrent: () => true });
    tracker.arm(client, false);
    await flush();

    expect(tracker.getState()?.state).toBe('unknown');
    expect(logger.debug).toHaveBeenCalledWith('Could not read WhatsApp Web sync progress', expect.anything());
  });

  it('forgets everything on reset', async () => {
    const page = newPage();
    const client = newClient(page);
    const tracker = new WwebjsSyncTracker({ logger: logger as never, sessionId: 's', isCurrent: () => true });
    tracker.arm(client, false);
    await flush();
    tracker.reset();

    expect(tracker.getState()).toBeNull();
    pushed(page)(snapshot());
    expect(tracker.getState()).toBeNull();
  });
});

describe('readEngineSyncState', () => {
  it('reads a reporting engine and answers null for one that does not report', () => {
    const state = { state: 'synced', phase: null, progress: null, paused: false, updatedAt: 'x' } as const;
    expect(readEngineSyncState({ getSyncState: () => state })).toBe(state);
    expect(readEngineSyncState({})).toBeNull();
    expect(readEngineSyncState(undefined)).toBeNull();
  });
});
