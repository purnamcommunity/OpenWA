package com.rmyndharis.openwa.model;

import com.google.gson.annotations.SerializedName;

/** The delivery running while a session is syncing. */
public enum SessionSyncPhase {
    @SerializedName("offline") OFFLINE,
    @SerializedName("history") HISTORY
}
