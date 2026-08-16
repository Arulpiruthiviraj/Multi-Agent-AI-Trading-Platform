import { describe, it, expect } from 'vitest';
import { resolveLivePitTimes } from './PitLedgerRecorder';

describe('resolveLivePitTimes', () => {
  it('uses now for both clocks when publishedAt is omitted', () => {
    const now = 1_700_000_000_000;
    expect(resolveLivePitTimes(undefined, now)).toEqual({ publishedAtMs: now, asOfMs: now });
  });

  it('keeps an earlier article timestamp and sets asOf to observation time', () => {
    const now = 1_700_000_000_000;
    const published = now - 60_000;
    expect(resolveLivePitTimes(published, now)).toEqual({ publishedAtMs: published, asOfMs: now });
  });

  it('refuses future publishedAt (look-ahead)', () => {
    const now = 1_700_000_000_000;
    expect(resolveLivePitTimes(now + 1, now)).toBeNull();
  });
});
