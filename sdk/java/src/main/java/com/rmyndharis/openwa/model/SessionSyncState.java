package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** Whether WhatsApp is still delivering a session's chats and history. */
public enum SessionSyncState {
    @SerializedName("syncing") SYNCING,
    @SerializedName("synced") SYNCED,
    @SerializedName("unknown") UNKNOWN
}
