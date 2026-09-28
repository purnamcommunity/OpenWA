package com.rmyndharis.openwa.model;

/**
 * Chat/history sync progress of a connected session.
 *
 * <p>{@code OFFLINE} is the catch-up of messages that arrived while the line was away (every connect
 * has one, usually brief); {@code HISTORY} is the older-message sync after a new link, which can run
 * for many minutes. {@code UNKNOWN} means the engine cannot tell, never that the sync is done.
 *
 * @param state whether WhatsApp is still delivering chats or history
 * @param phase the running delivery while {@code SYNCING}; {@code null} otherwise
 * @param progress percent complete WhatsApp reports for the running phase, or {@code null} when it has not said
 * @param paused WhatsApp paused the history sync because the phone stopped sending; it resumes on its own
 * @param updatedAt ISO timestamp of the last change to state, phase, progress or paused
 */
public record SessionSync(
    SessionSyncState state, SessionSyncPhase phase, Double progress, Boolean paused, String updatedAt) {}
