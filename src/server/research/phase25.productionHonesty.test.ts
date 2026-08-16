/**
 * Production honesty regressions — costs, parity labels, promotion fail-closed.
 */
import { describe, it, expect } from 'vitest';
import { researchSafety, isTheoreticalZeroCost } from '../config/researchSafety';
import { evidenceFromCanonicalRun, deriveLifecycleStatus, emptyEvidence } from './promotionEngine';
import { loadStrategySpec } from './strategySpecs';
import { resolvePaperTestingOverlay } from './paperTestingOverlay';
import type { CanonicalBacktestResult } from './canonicalNextBarEngine';

describe('Production remediation honesty', () => {
  it('researchSafety costs are loaded non-silently and currently non-zero', () => {
    expect(Number.isFinite(researchSafety.commissionPerShare)).toBe(true);
    expect(Number.isFinite(researchSafety.spreadBps)).toBe(true);
    expect(Number.isFinite(researchSafety.slippageBps)).toBe(true);
    expect(isTheoreticalZeroCost()).toBe(false);
    expect(researchSafety.zeroCostBlocksPromotion).toBe(true);
  });

  it('CORE strategy specs are FEATURE_SUBSET_PARITY not full StrategyContext parity', () => {
    for (const id of researchSafety.coreStrategyIds) {
      expect((loadStrategySpec(id) as any).vectorbtParity).toBe('FEATURE_SUBSET_PARITY');
    }
  });

  it('THEORETICAL_ZERO_COST canonical run cannot set backtestPass or LIVE_*', () => {
    const run = {
      strategyId: 'MOMENTUM_BREAKOUT',
      strategyVersion: '1',
      provenance: 'REAL_MARKET_DATA',
      quality: 'GREEN',
      backtestPass: true,
      executionModel: 'NEXT_BAR_OPEN',
      costModel: 'THEORETICAL_ZERO_COST',
      rejection: 'THEORETICAL_ZERO_COST',
    } as CanonicalBacktestResult;
    const e = evidenceFromCanonicalRun(run);
    expect(e.backtestPass).toBe(false);
    const status = deriveLifecycleStatus(e);
    // Config currently non-zero → zero-cost artifact fails backtestPass; may sit at BACKTEST_ONLY (data green) or UNTESTED.
    expect(['UNTESTED', 'BACKTEST_ONLY']).toContain(status);
    expect(status.startsWith('LIVE_')).toBe(false);
    expect(status).not.toBe('VALIDATED');
    expect(status).not.toBe('LIVE_CANDIDATE');
  });

  it('empty evidence stays UNTESTED / LIVE NO-GO', () => {
    const e = emptyEvidence('MOMENTUM_BREAKOUT');
    expect(deriveLifecycleStatus(e)).toBe('UNTESTED');
  });

  it('research-param overlay never claims applied while QUANT off', () => {
    expect(process.env.QUANT_ENGINE_ENABLED).not.toBe('true');
    const o = resolvePaperTestingOverlay('BULLISH_TREND');
    expect(o.applied).toBe(false);
  });
});
