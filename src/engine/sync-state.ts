/**
 * Whether WhatsApp is still bringing a linked line's chats and history into the engine, as the
 * engine itself observes it.
 *
 * A runtime report, not an engine capability: no route acts on it, and an engine that cannot
 * observe its own sync simply does not implement {@link EngineSyncStateReporter}. That is why it
 * sits beside `IWhatsAppEngine` rather than on it — a method there must either work or throw a 501,
 * and "this engine does not say" is neither.
 */
export interface EngineSyncState {
  /**
   * `syncing` while WhatsApp is still delivering chats or history to this line; `synced` once the
   * engine has seen that delivery finish; `unknown` when the engine cannot tell (the page's sync
   * signals are unreadable, or WhatsApp stopped reporting progress before it finished).
   */
  state: 'syncing' | 'synced' | 'unknown';
  /**
   * Which delivery is running while `syncing`: `offline` is the catch-up of messages that arrived
   * while the line was away (every connect has one, usually brief); `history` is the older-message
   * sync that follows a new link and can run for many minutes. Null unless `syncing`.
   */
  phase: 'offline' | 'history' | null;
  /** Percent complete as WhatsApp reports it for the running phase, or null when it has not said. */
  progress: number | null;
  /** WhatsApp paused the history sync because the phone stopped sending (it resumes on its own). */
  paused: boolean;
  /** When `state`, `phase`, `progress` or `paused` last changed (ISO 8601). */
  updatedAt: string;
}

/** An engine that can report {@link EngineSyncState}. */
export interface EngineSyncStateReporter {
  /** The current sync state, or null while the engine has no connected line to report on. */
  getSyncState(): EngineSyncState | null;
}

/** The engine's sync state when it reports one, else null. */
export function readEngineSyncState(engine: unknown): EngineSyncState | null {
  const reporter = engine as Partial<EngineSyncStateReporter> | null | undefined;
  if (typeof reporter?.getSyncState !== 'function') return null;
  return reporter.getSyncState() ?? null;
}
