package com.rmyndharis.openwa.model;

/**
 * Query parameters for {@code GET /sessions/:id/messages/:chatId/:messageId/poll-votes}. Null
 * fields are omitted.
 */
public record PollVotesQuery(Boolean resolveContacts) {}
