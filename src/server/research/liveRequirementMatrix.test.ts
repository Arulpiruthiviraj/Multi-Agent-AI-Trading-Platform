import { describe, it, expect } from 'vitest';
import { researchSafety } from '../config/researchSafety';
import { emptyEvidence } from './promotionEngine';
import {
  buildLiveRequirementMatrix,
  buildStrategyBoard,
  classifyStrategy,
  liveEligibilityFromMatrix,
} from './liveRequirementMatrix';

describe('LIVE requirement matrix (fail-closed)', () => {
  it('A–Z catalog never invents empirical PASS and liveEligibility is FAIL', () => {
    const rows = buildLiveRequirementMatrix();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('A_SPINE');
    expect(ids).toContain('P_OOS');
    expect(ids).toContain('V_ORGANIC');
    expect(ids).toContain('Z_HUMAN');
    expect(rows.find((r) => r.id === 'P_OOS')?.status).toBe('BROKEN');
    expect(rows.find((r) => r.id === 'Q_WFO')?.status).toBe('BROKEN');
    expect(rows.find((r) => r.id === 'V_ORGANIC')?.status).toBe('MISSING');
    expect(rows.find((r) => r.id === 'W_SOAK')?.status).toBe('MISSING');
    const elig = liveEligibilityFromMatrix(rows);
    expect(elig.engineeringCapableOfLiveExecution).toBe(true);
    expect(elig.empiricallyJustifiedToRiskCapital).toBe(false);
    expect(elig.liveEligibility).toBe('FAIL');
  });

  it('negative OOS expectancy at minOosTrades is RETIRE, not CONTINUE_PAPER', () => {
    const r = classifyStrategy({
      family: 'CORE',
      evidence: emptyEvidence('RANGE_REVERSION'),
      oosTrades: researchSafety.minOosTrades,
      oosExpectancy: researchSafety.minOosExpectancy - 0.01,
    });
    expect(r.classification).toBe('RETIRE');
  });

  it('OOS pass without WFO is CONTINUE_PAPER, never PROMOTE', () => {
    const e = emptyEvidence('PULLBACK_CONTINUATION');
    e.oosPass = true;
    e.walkForwardPass = false;
    const r = classifyStrategy({
      family: 'CORE',
      evidence: e,
      oosTrades: researchSafety.minOosTrades,
      oosExpectancy: 0.1,
    });
    expect(r.classification).toBe('CONTINUE_PAPER');
  });

  it('experimental strategies are RESEARCH_ONLY', () => {
    const r = classifyStrategy({
      family: 'EXPERIMENTAL',
      evidence: emptyEvidence('SMC_LIQUIDITY_SWEEP'),
      oosTrades: 999,
      oosExpectancy: 10,
    });
    expect(r.classification).toBe('RESEARCH_ONLY');
  });

  it('strategy board includes CORE five and experimental ids; none are LIVE GO', () => {
    const board = buildStrategyBoard();
    for (const id of researchSafety.coreStrategyIds) {
      expect(board.some((r) => r.strategyId === id && r.family === 'CORE')).toBe(true);
    }
    expect(board.some((r) => r.strategyId === 'SMC_LIQUIDITY_SWEEP' && r.family === 'EXPERIMENTAL')).toBe(true);
    expect(board.every((r) => r.live === 'NO-GO')).toBe(true);
    expect(board.every((r) => r.classification !== 'PROMOTE')).toBe(true);
  });
});
