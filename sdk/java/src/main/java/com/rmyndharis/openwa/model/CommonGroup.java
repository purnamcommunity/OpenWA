package com.rmyndharis.openwa.model;

/** A group the account shares with one contact. {@code name} is {@code null} when the engine has none for it yet. */
public record CommonGroup(String id, String name) {}
