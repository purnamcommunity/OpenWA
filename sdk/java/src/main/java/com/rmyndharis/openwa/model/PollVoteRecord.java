package com.rmyndharis.openwa.model;

import java.util.List;

/**
 * One voter's CURRENT selection on a poll — not a running count. A voter who changes their mind
 * sends their whole new selection, and an empty {@code selectedOptions} means they cleared their
 * vote, so a tally keeps one entry per voter and replaces it.
 *
 * <p>The {@code voter*} identity fields are null unless the read asked for {@code resolveContacts}.
 */
public record PollVoteRecord(
    String voterId,
    List<String> selectedOptions,
    Long timestamp,
    String voterName,
    String voterPushName,
    String voterPhone) {}
