package com.rmyndharis.openwa.model;

/**
 * The newest thing in a chat when that thing is not a message — a reply on a community
 * announcement, a reaction, a vote.
 *
 * <p>These move a chat to the top of the list while changing nothing a message read can see, so
 * without this the chat rises showing its previous message and the reason is invisible.
 */
public record ChatActivityPreview(
    String kind, String senderId, long timestamp, String parentMessageId) {}
