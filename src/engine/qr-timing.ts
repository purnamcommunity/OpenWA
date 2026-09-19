/**
 * When a QR code was issued and when it stops linking.
 *
 * WhatsApp hands out QR refs in rounds: the first code of a round links for 60 seconds, each later
 * one for 20. A round ends when its refs run out; the page then idles before starting the next, so
 * the gap before a round's first code is always longer than the 60-second first lifetime. That gap
 * is what marks a new round — neither engine reports the ref's position or TTL.
 */
export interface QrTiming {
  /** Epoch ms the gateway received this code. */
  issuedAt: number;
  /** Epoch ms after which WhatsApp no longer accepts it. */
  expiresAt: number;
}

export const QR_FIRST_LIFETIME_MS = 60_000;
export const QR_NEXT_LIFETIME_MS = 20_000;
/** A gap longer than the first code's lifetime (plus slack for delivery) can only be a new round. */
const NEW_ROUND_GAP_MS = QR_FIRST_LIFETIME_MS + 5_000;

export function nextQrTiming(previous: QrTiming | null, now: number): QrTiming {
  const newRound = !previous || now - previous.issuedAt > NEW_ROUND_GAP_MS;
  return { issuedAt: now, expiresAt: now + (newRound ? QR_FIRST_LIFETIME_MS : QR_NEXT_LIFETIME_MS) };
}
