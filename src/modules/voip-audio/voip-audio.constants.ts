/**
 * The one PCM format the bridge speaks, end to end: signed 16-bit little-endian, 48 kHz, mono.
 *
 * It is fixed rather than negotiated because every hop already agrees on it — a browser
 * AudioWorklet resamples to whatever it is told, PulseAudio converts per-stream, and WhatsApp
 * encodes Opus from whatever Chromium captures. Making it configurable would add a negotiation
 * step whose only outcome is a chance for the two ends to disagree.
 */
export const PCM_FORMAT = 's16le';
export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 1;
export const PCM_BYTES_PER_SAMPLE = 2;

/** 20 ms of audio — the frame size WebRTC itself uses, and small enough that a dropped frame is
 *  inaudible rather than a click. */
export const FRAME_MS = 20;
export const FRAME_BYTES = (PCM_SAMPLE_RATE / 1000) * FRAME_MS * PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;

/**
 * Ceiling on audio buffered toward the gateway's microphone. PulseAudio does not drop late audio —
 * it plays everything eventually, so a client that sends faster than realtime (or a stalled pipe)
 * builds unbounded delay that never recovers within the call. Past this the oldest frames are
 * dropped: a caller would rather lose a syllable than fall a minute behind.
 */
export const MAX_MIC_BACKLOG_BYTES = FRAME_BYTES * 25; // ~500 ms
