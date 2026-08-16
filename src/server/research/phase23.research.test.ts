import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreParityVector, nextOpenFillStats, vectorsMatch } from './coreParityVectors';
import { compareEngines } from './VectorBTService';
import { loadStrategySpec } from './strategySpecs';
import { resolvePaperTestingOverlay } from './paperTestingOverlay';
import { researchSafety } from '../config/researchSafety';
import type { ResearchBar } from './ohlcvTypes';

const fixture = JSON.parse(readFileSync(join(process.cwd(), 'fixtures/research/golden_core_parity.json'), 'utf8'));

describe('Phase 23 CORE vector parity and paper-testing overlay', () => {
  it('UNIT_FIXTURE expectedTsVector matches live TS engines (zero ENGINE_MISMATCH vs self)', () => {
    const bars = fixture.bars as ResearchBar[];
    const ts = coreParityVector(bars);
    expect(vectorsMatch(ts, fixture.expectedTsVector)).toBe(true);
    const buys = bars.map((_, i) => i % 8 === 0);
    expect(compareEngines(nextOpenFillStats(bars, buys), nextOpenFillStats(bars, buys)).status).toBe('PASS');
    expect(fixture.fullStrategyParity).toBe(false);
    expect(fixture.provenance).toBe('UNIT_FIXTURE');
  });

  it('CORE VectorBT adapter tag is FEATURE_SUBSET_PARITY; SMC stays PROXY', () => {
    for (const id of researchSafety.coreStrategyIds) {
      expect((loadStrategySpec(id) as any).vectorbtParity).toBe('FEATURE_SUBSET_PARITY');
    }
    expect((loadStrategySpec('SMC_LIQUIDITY_SWEEP') as any).vectorbtParity).toBe('PROXY_NOT_FEATURE_PARITY');
  });

  it('paper-testing overlay is idle while QUANT_ENGINE_ENABLED is unset', () => {
    expect(process.env.QUANT_ENGINE_ENABLED).not.toBe('true');
    const overlay = resolvePaperTestingOverlay('BULLISH_TREND');
    expect(overlay.applied).toBe(false);
    expect(overlay.reason).toMatch(/QUANT_ENGINE_ENABLED/);
  });
});
