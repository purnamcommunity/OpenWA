import { nextQrTiming, QR_FIRST_LIFETIME_MS, QR_NEXT_LIFETIME_MS } from './qr-timing';

describe('nextQrTiming', () => {
  const t0 = 1_000_000;

  it('gives the first code of a session the first-round lifetime', () => {
    expect(nextQrTiming(null, t0)).toEqual({ issuedAt: t0, expiresAt: t0 + QR_FIRST_LIFETIME_MS });
  });

  it('gives a code that replaces a live round the shorter lifetime', () => {
    const first = nextQrTiming(null, t0);
    const second = nextQrTiming(first, t0 + 60_000);
    const third = nextQrTiming(second, t0 + 80_000);
    expect(second.expiresAt - second.issuedAt).toBe(QR_NEXT_LIFETIME_MS);
    expect(third.expiresAt - third.issuedAt).toBe(QR_NEXT_LIFETIME_MS);
  });

  it('starts a new round after the idle gap between rounds', () => {
    const last = { issuedAt: t0, expiresAt: t0 + QR_NEXT_LIFETIME_MS };
    const next = nextQrTiming(last, t0 + 71_000);
    expect(next.expiresAt - next.issuedAt).toBe(QR_FIRST_LIFETIME_MS);
  });
});
