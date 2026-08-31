import { mapWwebjsPollVote, mapWwebjsPollVoteEvent, normalizePollVoteTimestamp } from './wwebjs-poll-votes';

/**
 * The mapping between whatsapp-web.js's `PollVote` and the neutral one. The library's own typings
 * describe a shape it does not deliver (a string voter, always-named options, no `parentMsgKey`),
 * so these cover what actually arrives rather than what `index.d.ts` claims.
 */
describe('mapWwebjsPollVote', () => {
  const base = {
    voter: { _serialized: '628123456789@c.us' },
    selectedOptions: [{ name: 'Park', localId: 0 }],
    interractedAtTs: 1_700_000_000_000,
  };

  it('reads a Wid voter, the option texts, and the timestamp in seconds', () => {
    expect(mapWwebjsPollVote(base)).toEqual({
      voterId: '628123456789@c.us',
      selectedOptions: ['Park'],
      timestamp: 1_700_000_000,
    });
  });

  it('accepts the plain-string voter the typings promise', () => {
    expect(mapWwebjsPollVote({ ...base, voter: '628123456789@c.us' })?.voterId).toBe('628123456789@c.us');
  });

  it('reads a renamed `$1` voter id (#747)', () => {
    expect(mapWwebjsPollVote({ ...base, voter: { $1: '99@lid' } })?.voterId).toBe('99@lid');
  });

  it('keeps an empty selection, which is how a CLEARED vote is reported', () => {
    // Not an error and not a missing value: dropping it would leave the voter's old selection
    // standing forever in any tally built from these.
    expect(mapWwebjsPollVote({ ...base, selectedOptions: [] })?.selectedOptions).toEqual([]);
  });

  it('drops an option the library could not name', () => {
    // PollVote._patch leaves `name` undefined when the vote's local id is not on the parent
    // message; an unnamed option cannot be matched to anything a caller displays.
    const vote = mapWwebjsPollVote({
      ...base,
      selectedOptions: [{ name: 'Park', localId: 0 }, { localId: 7 }],
    });
    expect(vote?.selectedOptions).toEqual(['Park']);
  });

  it('returns null when the voter cannot be read', () => {
    // A vote replaces THAT VOTER's selection; with no voter it can only be counted as an extra
    // vote, which is worse than losing it.
    expect(mapWwebjsPollVote({ ...base, voter: undefined })).toBeNull();
  });
});

describe('normalizePollVoteTimestamp', () => {
  it('converts WhatsApp milliseconds to seconds', () => {
    expect(normalizePollVoteTimestamp(1_700_000_000_000)).toBe(1_700_000_000);
  });

  it('leaves a value already in seconds alone', () => {
    // Dividing again would land in 1970 — a wrong ordering that still looks like a real date.
    expect(normalizePollVoteTimestamp(1_700_000_000)).toBe(1_700_000_000);
  });

  it('falls back to now when the stamp is missing or nonsense', () => {
    expect(normalizePollVoteTimestamp(undefined, 1_700_000_500_000)).toBe(1_700_000_500);
    expect(normalizePollVoteTimestamp(0, 1_700_000_500_000)).toBe(1_700_000_500);
    expect(normalizePollVoteTimestamp(Number.NaN, 1_700_000_500_000)).toBe(1_700_000_500);
  });
});

describe('mapWwebjsPollVoteEvent', () => {
  const base = {
    voter: { _serialized: '628123456789@c.us' },
    selectedOptions: [{ name: 'Beach', localId: 1 }],
    interractedAtTs: 1_700_000_000_000,
    parentMessage: { id: { _serialized: 'POLL1' }, from: '12036@g.us' },
    parentMsgKey: { _serialized: 'POLL1', remote: { _serialized: '12036@g.us' } },
  };

  it('names the poll and the chat it lives in', () => {
    expect(mapWwebjsPollVoteEvent(base)).toEqual({
      voterId: '628123456789@c.us',
      selectedOptions: ['Beach'],
      timestamp: 1_700_000_000,
      messageId: 'POLL1',
      chatId: '12036@g.us',
    });
  });

  it('falls back to the parent key when WA Web did not resolve the poll message', () => {
    // `parentMessage` is null whenever the poll creation is not in the local store — the key is
    // the only id present on every vote.
    const event = mapWwebjsPollVoteEvent({ ...base, parentMessage: null });
    expect(event?.messageId).toBe('POLL1');
    expect(event?.chatId).toBe('12036@g.us');
  });

  it('returns null when no poll can be identified', () => {
    // An event with a blank messageId would be applied to whatever an empty id happens to match.
    expect(mapWwebjsPollVoteEvent({ ...base, parentMessage: null, parentMsgKey: null })).toBeNull();
  });

  it('returns null when the chat cannot be identified', () => {
    expect(
      mapWwebjsPollVoteEvent({ ...base, parentMessage: { id: { _serialized: 'POLL1' } }, parentMsgKey: null }),
    ).toBeNull();
  });
});
