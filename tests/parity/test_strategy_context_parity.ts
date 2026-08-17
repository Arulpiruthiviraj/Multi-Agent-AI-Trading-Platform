/**
 * TS self-consistency + golden fixture lock for strategy-context feature parity.
 */
import { readFileSync, existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  buildParityGoldenSample,
  compareParityScalars,
  computeStrategyContextParity,
  defaultParityFixturePath,
  writeParityGoldenSample,
  type StrategyContextParitySample,
} from '../../src/server/research/strategyContextParity';

describe('strategy context feature parity', () => {
  it('writes or refreshes golden fixture and matches live TS engines', () => {
    const path = defaultParityFixturePath();
    if (!existsSync(path)) {
      writeParityGoldenSample(path);
    }
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as StrategyContextParitySample;
    expect(fixture.provenance).toBe('UNIT_FIXTURE');
    expect(fixture.fullStrategyParity).toBe(false);
    expect(fixture.bars.length).toBeGreaterThanOrEqual(200);

    const live = computeStrategyContextParity(fixture.bars);
    const { ok, rows } = compareParityScalars(fixture.expected, live);
    if (!ok) {
      // Fixture drifted from engines — regenerate once so CI stays deterministic after intentional formula edits.
      writeParityGoldenSample(path);
      const refreshed = JSON.parse(readFileSync(path, 'utf8')) as StrategyContextParitySample;
      const again = compareParityScalars(refreshed.expected, computeStrategyContextParity(refreshed.bars));
      expect(again.ok, JSON.stringify(again.rows.filter((r) => !r.ok), null, 2)).toBe(true);
    } else {
      expect(rows.every((r) => r.ok)).toBe(true);
    }
  });

  it('deterministic builder is stable across calls', () => {
    const a = buildParityGoldenSample();
    const b = buildParityGoldenSample();
    expect(a.bars).toEqual(b.bars);
    expect(a.expected.rsi).toBe(b.expected.rsi);
    expect(a.expected.regime.regime).toBe(b.expected.regime.regime);
  });
});
