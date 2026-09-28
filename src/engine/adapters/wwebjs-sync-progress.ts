import { type Client } from 'whatsapp-web.js';
import { type createLogger } from '../../common/services/logger.service';
import { type EngineSyncState } from '../sync-state';

/**
 * Sync progress for a whatsapp-web.js line, read from the same WhatsApp Web state its own UI
 * renders. Two deliveries are tracked, because WhatsApp Web runs two:
 *
 *  - OFFLINE RESUME — the catch-up of messages sent while the companion was away. Every connect has
 *    one. `WAWebOfflineHandler.OfflineMessageHandler` owns it: `isResumeComplete()` is its end, and
 *    `getOfflineDeliveryProgress()` the percent its "Loading messages (n%)" / "Syncing chats…" bars
 *    show. Both bars re-read it on the `WAWebCmd` events `offline_progress_update_from_bridge` and
 *    `offline_delivery_end_from_bridge`, so those are what this listens to as well. (whatsapp-web.js
 *    forwards the first of them as its `loading_screen` event.)
 *  - HISTORY SYNC — the older-message transfer after a new link, which can run for many minutes
 *    after `ready`. `WAWebHistorySyncProgressModel.getHistorySyncProgressModel()` is the singleton
 *    behind the "Syncing older messages" modal, and `WAWebHistorySyncProgressGetters` derives from
 *    it exactly what that modal shows: `getInProgress` (incomplete, below 100%, not paused out),
 *    `getPaused`, and the progress. The backend writes `incomplete` from the persisted
 *    `recentCompleted` flag and `realProgress` from the chunk counts on every RECENT chunk, and sets
 *    `{progress: 100, incomplete: false}` when the recent history is complete. Its `change:*` events
 *    are what this listens to.
 *
 * The model starts every page load as `incomplete: false, realProgress: null`, and only turns
 * incomplete when the first history chunk is handled. So right after a NEW link it reads "not in
 * progress" until that chunk lands. A line this adapter linked (it showed a QR) therefore counts as
 * syncing from `ready` until WhatsApp says the recent history is done — the model reaching 100%, or
 * the persisted `WAWebUserPrefsHistorySync.getHistorySyncStatus().recentCompleted` — or until
 * WhatsApp gives up on a silent phone (its pause runs out), or {@link FRESH_LINK_SYNC_CAP_MS}
 * passes with neither. The last two end as `unknown`, never `synced`: nothing confirmed completion.
 * The persisted flag is only ever read as confirmation. Its absence is not evidence of a pending
 * sync, so a restored line is judged by the live model alone.
 *
 * Event-driven: one evaluate when the line becomes ready (and again after a navigation re-inject),
 * then the page pushes a snapshot through an exposed binding, coalesced to at most one per second.
 * No Node timers, and nothing polls the page.
 */

/** Page binding the in-page watcher pushes snapshots through. */
export const SYNC_PROGRESS_BINDING = 'openwaOnSyncProgress';

/**
 * How long a newly linked line counts as syncing without WhatsApp confirming anything. WhatsApp
 * pauses a history sync after 120s without a chunk and drops its own progress UI after a further
 * 1200s paused, so a sync that is still silent after this is one WhatsApp itself has given up on.
 */
export const FRESH_LINK_SYNC_CAP_MS = 30 * 60_000;

/** What the in-page watcher reads. Each part is null when its WhatsApp Web module is unreadable. */
export interface WaSyncSnapshot {
  offline: { started: boolean; complete: boolean; progress: number | null } | null;
  history: {
    incomplete: boolean;
    realProgress: number | null;
    inProgress: boolean;
    paused: boolean;
    /** WhatsApp's pause countdown ran out and it stopped showing progress. */
    pausedOut: boolean;
  } | null;
  /** True only when WhatsApp's persisted history status says the recent history is complete. */
  recentHistoryComplete: boolean;
}

/**
 * In-page: read a {@link WaSyncSnapshot}, and on the first call in a document subscribe to the
 * events that change it, pushing a fresh snapshot through `window[bindingName]`.
 *
 * Self-contained because `page.evaluate` stringifies it into the browser: every input arrives as an
 * argument and nothing is closed over. The subscription is marked on `window`, so a navigation
 * (a new document) subscribes again and a repeat call in the same document does not.
 */
export function watchSyncProgress(bindingName: string): WaSyncSnapshot {
  type Listenable = { on(event: string, cb: () => void): void };
  const w = window as unknown as Record<string, unknown> & { require: (id: string) => Record<string, unknown> };
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  const read = (): WaSyncSnapshot => {
    let offline: WaSyncSnapshot['offline'];
    try {
      const handler = w.require('WAWebOfflineHandler').OfflineMessageHandler as {
        hasInitOfflineResumeManager(): boolean;
        isResumeComplete(): boolean;
        getOfflineDeliveryProgress(): number;
      };
      // Before the offline preview arrives there is no resume manager, and its readers throw.
      offline = handler.hasInitOfflineResumeManager()
        ? {
            started: true,
            complete: handler.isResumeComplete() === true,
            progress: num(handler.getOfflineDeliveryProgress()),
          }
        : { started: false, complete: false, progress: null };
    } catch {
      offline = null;
    }

    let history: WaSyncSnapshot['history'];
    try {
      const model = (
        w.require('WAWebHistorySyncProgressModel').getHistorySyncProgressModel as () => Record<string, unknown>
      )();
      const getters = w.require('WAWebHistorySyncProgressGetters') as Record<string, (m: unknown) => unknown>;
      const remaining = num(model.remainingPausedSeconds);
      history = {
        incomplete: model.incomplete === true,
        realProgress: num(model.realProgress),
        inProgress: getters.getInProgress(model) === true,
        paused: getters.getPaused(model) === true,
        pausedOut: remaining !== null && remaining <= 0,
      };
    } catch {
      history = null;
    }

    let recentHistoryComplete: boolean;
    try {
      const status = (w.require('WAWebUserPrefsHistorySync').getHistorySyncStatus as () => unknown)();
      recentHistoryComplete =
        !!status &&
        typeof (status as { then?: unknown }).then !== 'function' &&
        (status as { recentCompleted?: unknown }).recentCompleted === true;
    } catch {
      recentHistoryComplete = false;
    }
    return { offline, history, recentHistoryComplete };
  };

  if (!w.__openwaSyncWatch) {
    w.__openwaSyncWatch = true;
    let queued = false;
    const push = (): void => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        try {
          const binding = w[bindingName];
          if (typeof binding === 'function') {
            void (binding as (s: WaSyncSnapshot) => Promise<unknown>)(read()).catch(() => undefined);
          }
        } catch {
          // The binding is gone with its page; the next document subscribes again.
        }
      }, 1000);
    };
    try {
      const model = (w.require('WAWebHistorySyncProgressModel').getHistorySyncProgressModel as () => Listenable)();
      for (const field of ['incomplete', 'realProgress', 'remainingPausedSeconds']) {
        model.on(`change:${field}`, push);
      }
    } catch {
      // Unreadable model: the snapshot reports `history: null`, which reads as unknown.
    }
    try {
      const cmd = w.require('WAWebCmd').Cmd as Listenable;
      cmd.on('offline_progress_update_from_bridge', push);
      cmd.on('offline_delivery_end_from_bridge', push);
    } catch {
      // Same: `offline: null`.
    }
  }
  return read();
}

/** Where a newly linked line's wait for WhatsApp's confirmation stands. */
export type FreshLinkOutcome = 'pending' | 'complete' | 'abandoned';

/**
 * Judge a snapshot. Pure, so every rule is unit-tested without a page.
 *
 * Order matters: a running offline catch-up is reported first (WhatsApp shows it first, and it is
 * what blocks the chat list), then a history sync the model reports in progress, then a new link
 * still waiting for confirmation. `freshLink` is the latched outcome for a line this adapter
 * linked, or null for a restored line.
 */
export function judgeSyncSnapshot(
  snapshot: WaSyncSnapshot | null,
  freshLink: { outcome: FreshLinkOutcome; readyAt: number } | null,
  now: number,
): {
  state: EngineSyncState['state'];
  phase: EngineSyncState['phase'];
  progress: number | null;
  paused: boolean;
  freshLinkOutcome: FreshLinkOutcome | null;
} {
  let outcome = freshLink?.outcome ?? null;
  if (snapshot?.history && freshLink && outcome === 'pending') {
    if (snapshot.recentHistoryComplete || (snapshot.history.realProgress ?? 0) >= 100) {
      outcome = 'complete';
    } else if (snapshot.history.pausedOut || now - freshLink.readyAt >= FRESH_LINK_SYNC_CAP_MS) {
      outcome = 'abandoned';
    }
  }
  const result = (
    state: EngineSyncState['state'],
    phase: EngineSyncState['phase'] = null,
    progress: number | null = null,
    paused = false,
  ): ReturnType<typeof judgeSyncSnapshot> => ({ state, phase, progress, paused, freshLinkOutcome: outcome });

  if (!snapshot) return result('unknown');
  if (snapshot.offline?.started && !snapshot.offline.complete) {
    return result('syncing', 'offline', snapshot.offline.progress);
  }
  const history = snapshot.history;
  if (!history) return result('unknown');
  if (history.inProgress) {
    return result('syncing', 'history', history.realProgress, history.paused);
  }
  if (outcome === 'pending') return result('syncing', 'history', history.realProgress);
  if (outcome === 'abandoned') return result('unknown');
  return result('synced');
}

export interface WwebjsSyncTrackerHost {
  readonly logger: ReturnType<typeof createLogger>;
  readonly sessionId: string;
  /** Whether `client` is still this adapter's live, unfinished client. */
  isCurrent(client: Client): boolean;
}

type SyncPage = {
  exposeFunction?: (name: string, fn: (snapshot: unknown) => void) => Promise<void>;
  evaluate?: (fn: (bindingName: string) => WaSyncSnapshot, bindingName: string) => Promise<unknown>;
};

function isSnapshot(value: unknown): value is WaSyncSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return 'offline' in v && 'history' in v && typeof v.recentHistoryComplete === 'boolean';
}

/**
 * Tracks one client's sync state. Owned by the lifecycle, which arms it when the line reaches READY
 * and again on each re-emitted `ready` (a navigation re-inject replaces the document, and with it
 * the in-page listeners), and resets it on teardown. A snapshot from any client but the armed one,
 * or from a finished adapter, is dropped.
 */
export class WwebjsSyncTracker {
  private client: Client | null = null;
  private snapshot: WaSyncSnapshot | null = null;
  private freshLink: { outcome: FreshLinkOutcome; readyAt: number } | null = null;
  private reported: Omit<EngineSyncState, 'updatedAt'> | null = null;
  private updatedAt = 0;
  // A page's exposed binding survives its navigations, and exposing the same name twice throws.
  private readonly exposedPages = new WeakSet<object>();

  constructor(private readonly host: WwebjsSyncTrackerHost) {}

  /**
   * Start (or, for the same client, refresh) tracking. `newlyLinked` is read only when a client is
   * first armed: it marks a line this adapter linked from a QR, whose history sync is still ahead.
   */
  arm(client: Client, newlyLinked: boolean): void {
    if (this.client !== client) {
      this.client = client;
      this.snapshot = null;
      this.reported = null;
      this.updatedAt = Date.now();
      this.freshLink = newlyLinked ? { outcome: 'pending', readyAt: Date.now() } : null;
    }
    void this.install(client);
  }

  reset(): void {
    this.client = null;
    this.snapshot = null;
    this.freshLink = null;
    this.reported = null;
  }

  /** The judged state for the armed client, or null when none is armed. */
  getState(now = Date.now()): EngineSyncState | null {
    if (!this.client) return null;
    return this.refresh(now);
  }

  private async install(client: Client): Promise<void> {
    const page = (client as unknown as { pupPage?: SyncPage | null }).pupPage;
    // Feature-detected: without a page that can carry a binding there is nothing to watch, and the
    // state stays `unknown`.
    if (!page || typeof page.exposeFunction !== 'function' || typeof page.evaluate !== 'function') return;
    try {
      if (!this.exposedPages.has(page)) {
        this.exposedPages.add(page);
        await page.exposeFunction(SYNC_PROGRESS_BINDING, snapshot => this.accept(client, snapshot));
      }
      if (!this.host.isCurrent(client) || this.client !== client) return;
      this.accept(client, await page.evaluate(watchSyncProgress, SYNC_PROGRESS_BINDING));
    } catch (error) {
      // Not a liveness signal: the page's health is the watchdog's to judge. The state stays as it
      // was, and the next re-inject arms again.
      this.host.logger.debug('Could not read WhatsApp Web sync progress', {
        sessionId: this.host.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private accept(client: Client, snapshot: unknown): void {
    if (this.client !== client || !this.host.isCurrent(client) || !isSnapshot(snapshot)) return;
    this.snapshot = snapshot;
    this.refresh(Date.now());
  }

  private refresh(now: number): EngineSyncState {
    const judged = judgeSyncSnapshot(this.snapshot, this.freshLink, now);
    if (this.freshLink && judged.freshLinkOutcome && judged.freshLinkOutcome !== this.freshLink.outcome) {
      this.freshLink = { ...this.freshLink, outcome: judged.freshLinkOutcome };
    }
    const next = { state: judged.state, phase: judged.phase, progress: judged.progress, paused: judged.paused };
    const prev = this.reported;
    if (
      !prev ||
      prev.state !== next.state ||
      prev.phase !== next.phase ||
      prev.progress !== next.progress ||
      prev.paused !== next.paused
    ) {
      if (prev) this.updatedAt = now;
      this.reported = next;
    }
    return { ...next, updatedAt: new Date(this.updatedAt).toISOString() };
  }
}
