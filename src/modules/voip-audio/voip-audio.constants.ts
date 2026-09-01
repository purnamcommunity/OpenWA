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
 * builds unbounded delay that never recovers within the call. Past this the INCOMING frame is
 * dropped — audio already written to the pipe cannot be recalled — so the cap is also the bound on
 * the standing delay this leg carries for the rest of the call: a generous cap is not slack, it is
 * latency the far end hears. A caller would rather lose a syllable than fall behind.
 */
export const MAX_MIC_BACKLOG_BYTES = FRAME_BYTES * 8; // ~160 ms

/**
 * Slack in the microphone pacing budget: how far ahead of realtime a client may run before the
 * incoming frame is dropped. The backlog cap above only sees bytes pacat has not yet taken off the
 * pipe — the OS pipe buffer itself silently holds ~680 ms more, so a client that BURSTS (a bug, a
 * stale bundle, a hostile token holder) can plant most of a second of standing delay the cap never
 * notices. The budget is cumulative against the wall clock from the first frame, so a network
 * stall followed by a legitimate catch-up burst passes — nothing was accepted during the stall —
 * and only genuinely faster-than-realtime audio is trimmed, which is exactly the audio the far
 * end must not hear late.
 */
export const MIC_PACING_SLACK_BYTES = FRAME_BYTES * 12; // ~240 ms
