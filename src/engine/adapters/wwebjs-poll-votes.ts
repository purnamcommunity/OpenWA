import { type PollVote } from '../interfaces/whatsapp-engine.interface';
import { type SerializedWid, readWid } from '../types/whatsapp-web-js.types';

/**
 * The whatsapp-web.js `PollVote` structure as it actually arrives, which is not what the library's
 * typings describe (index.d.ts:1483):
 *  - `voter` is documented as a string, but the page hook assigns the raw Wid object it read off
 *    the vote row (`Client.js:1218` sets `sender = vote.author ?? vote.from`, and
 *    `PollVote._patch` assigns `this.voter = data.sender`). Both shapes are accepted here.
 *  - `selectedOptions[].name` is documented as a string, but is `undefined` whenever the vote's
 *    local option id is not found on the parent message — the "temporary failsafe" branch in
 *    `PollVote._patch`.
 */
export interface RawWwebjsPollVote {
  voter?: SerializedWid | string;
  selectedOptions?: { name?: string; localId?: number }[];
  interractedAtTs?: number;
}

/**
 * WhatsApp stamps a vote in MILLISECONDS (`senderTimestampMs`), while every neutral engine event is
 * in Unix seconds. Convert by magnitude rather than by trusting the field name: the same structure
 * is built from two different sources (the live table hook and the stored votes table), and a value
 * already in seconds divided again lands in 1970 — a wrong ordering that looks like real data.
 * Anything unreadable falls back to now, so a vote is never dropped over its clock alone.
 */
export function normalizePollVoteTimestamp(raw: number | undefined, now = Date.now()): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return Math.floor(now / 1000);
  // 1e11 seconds is the year 5138 and 1e11 ms is 1973: no real WhatsApp timestamp is ambiguous here.
  return raw >= 1e11 ? Math.floor(raw / 1000) : Math.floor(raw);
}

/**
 * Map one raw vote to the neutral {@link PollVote}. Returns null only when the voter cannot be
 * read — a vote with no voter cannot replace that voter's previous selection, which is the whole
 * contract of the type, and counting it would be worse than dropping it.
 *
 * An empty `selectedOptions` is NOT a failure: that is exactly how WhatsApp reports a cleared vote.
 */
export function mapWwebjsPollVote(raw: RawWwebjsPollVote): PollVote | null {
  const voterId = readWid(raw.voter);
  if (!voterId) return null;
  return {
    voterId,
    selectedOptions: (raw.selectedOptions ?? [])
      .map(option => option?.name)
      .filter((name): name is string => typeof name === 'string'),
    timestamp: normalizePollVoteTimestamp(raw.interractedAtTs),
  };
}
