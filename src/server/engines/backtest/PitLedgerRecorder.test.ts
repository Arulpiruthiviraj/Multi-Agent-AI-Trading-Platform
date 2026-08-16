import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('DATA_QUALITY PIT kind', () => {
  it('is a first-class ledger kind distinct from agent votes', () => {
    const src = readFileSync(join(process.cwd(), 'src/server/engines/backtest/PitLedgerRecorder.ts'), 'utf8');
    expect(src).toMatch(/DATA_QUALITY/);
    expect(src).not.toMatch(/side: 'HOLD'.*DATA_QUALITY/);
  });
});
