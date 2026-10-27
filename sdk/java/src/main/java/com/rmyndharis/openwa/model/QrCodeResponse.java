package com.rmyndharis.openwa.model;

/** Live QR code for authenticating a session. */
public record QrCodeResponse(
    /** Data URL, e.g. {@code data:image/png;base64,…}. */
    String qrCode,
    SessionStatus status,
    /** When the gateway received this QR code (ISO 8601); null when the gateway did not say. */
    String issuedAt,
    /**
     * When WhatsApp stops accepting this QR code (ISO 8601): 60 s for a round's first code, 20 s for
     * each later one. Null when the gateway did not say.
     */
    String expiresAt) {}
