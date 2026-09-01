package com.rmyndharis.openwa.model;

/**
 * One reply in a community announcement's reply thread.
 *
 * <p>Not a chat message: WhatsApp keeps these as add-ons on the announcement, so they appear in no
 * history read. {@code body} is null for a deleted reply and for one carrying no text.
 */
public record CommentRecord(
    String id,
    String parentMessageId,
    String authorId,
    long timestamp,
    String body,
    boolean revoked,
    boolean fromMe) {}
