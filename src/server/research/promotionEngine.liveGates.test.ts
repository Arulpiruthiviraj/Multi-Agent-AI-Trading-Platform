import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { researchSafety } from '../config/researchSafety';
import { deriveLifecycleStatus, emptyEvidence, liveGoNoGo, type StrategyEvidence } from './promotionEngine';

function liveCandidateFixture(overrides: Partial<StrategyEvidence> = {}): StrategyEvidence {
  return {
    ...emptyEvidence('MOMENTUM_BREAKOUT', '1.0.0'),
    dataProvenance: 'REAL_MARKET_DATA',
    executionModel: 'NEXT_BAR_OPEN',
    qualityStatus: 'GREEN',
    parquetBytesWritten: true,
    dataQualityPass: true,
    backtestPass: true,
    oosPass: true,
    walkForwardPass: true,
    monteCarloPass: true,
    permutationPass: true,
    sensitivityPass: true,
    costStressPass: true,
    paperTrades: researchSafety.minPaperTrades,
    paperSessions: researchSafety.minPaperSessions,
    paperExpectancyPositive: true,
    paperDrawdownWithinLimit: true,
    paperProfitFactorPass: true,
    paperCalendarDaysPass: true,
    riskGatePass: true,
    brokerHealthPass: true,
    marketDataHealthPass: true,
    startupHealthPass: true,
    omsHealthPass: true,
    reconciliationHealthPass: true,
    restartRecoveryPass: true,
    failureRecoveryPass: true,
    observabilityPass: true,
    securityPass: true,
    organicPaperOnly: true,
    manualLiveApproval: false,
    ...overrides,
  };
}

describe('promotion live gates (fail-closed)', () => {
  it('researchSafety paper/OOS floors come from config JSON, not TypeScript literals', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'config', 'researchSafety.json'), 'utf8'));
    expect(researchSafety.minPaperTrades).toBe(raw.minPaperTrades);
    expect(researchSafety.minPaperSessions).toBe(raw.minPaperSessions);
    expect(researchSafety.minPaperCalendarDays).toBe(raw.minPaperCalendarDays);
    expect(researchSafety.minPaperProfitFactor).toBe(raw.minPaperProfitFactor);
    expect(researchSafety.minPaperExpectancy).toBe(raw.minPaperExpectancy);
    expect(researchSafety.maxPaperDrawdownPct).toBe(raw.maxPaperDrawdownPct);
    expect(researchSafety.minOosTrades).toBe(raw.minOosTrades);
    expect(researchSafety.minOosExpectancy).toBe(raw.minOosExpectancy);
    expect(researchSafety.minWalkForwardWindows).toBe(raw.minWalkForwardWindows);
    expect(researchSafety.permutationAlpha).toBe(raw.permutationAlpha);
    expect(researchSafety.costStressMaxMultipleStillProfitable).toBe(raw.costStressMaxMultipleStillProfitable);
    expect(researchSafety.minPaperCalendarDays).toBeGreaterThanOrEqual(researchSafety.minPaperSessions);
    expect(researchSafety.minPaperProfitFactor).toBeGreaterThan(1);
  });

  it('empty evidence fails the new ops/paper gates', () => {
    const failed = liveGoNoGo(emptyEvidence('MOMENTUM_BREAKOUT')).failedGates;
    expect(failed).toContain('PAPER_PROFIT_FACTOR');
    expect(failed).toContain('PAPER_CALENDAR_DAYS');
    expect(failed).toContain('OMS_HEALTH');
    expect(failed).toContain('RECONCILIATION_HEALTH');
    expect(failed).toContain('RESTART_RECOVERY');
    expect(failed).toContain('FAILURE_RECOVERY');
    expect(failed).toContain('OBSERVABILITY');
    expect(failed).toContain('SECURITY');
    expect(liveGoNoGo(emptyEvidence('MOMENTUM_BREAKOUT')).live).toBe('NO-GO');
  });

  it('omitting omsHealthPass cannot reach LIVE_CANDIDATE', () => {
    const e = liveCandidateFixture({ omsHealthPass: false });
    expect(deriveLifecycleStatus(e)).not.toBe('LIVE_CANDIDATE');
    expect(deriveLifecycleStatus(e)).not.toBe('LIVE_APPROVED');
    expect(liveGoNoGo(e).failedGates).toContain('OMS_HEALTH');
    expect(liveGoNoGo(e).live).toBe('NO-GO');
  });

  it('omitting paperProfitFactorPass cannot reach LIVE_CANDIDATE', () => {
    const e = liveCandidateFixture({ paperProfitFactorPass: false });
    expect(deriveLifecycleStatus(e)).not.toBe('LIVE_CANDIDATE');
    expect(liveGoNoGo(e).failedGates).toContain('PAPER_PROFIT_FACTOR');
  });

  it('LIVE_CANDIDATE without manual approval is still NO-GO; approval is last', () => {
    const candidate = liveCandidateFixture();
    expect(deriveLifecycleStatus(candidate)).toBe('LIVE_CANDIDATE');
    expect(liveGoNoGo(candidate).live).toBe('NO-GO');
    expect(liveGoNoGo(candidate).failedGates).toEqual(['MANUAL_APPROVAL']);
    const approved = liveCandidateFixture({ manualLiveApproval: true });
    expect(deriveLifecycleStatus(approved)).toBe('LIVE_APPROVED');
    expect(liveGoNoGo(approved).live).toBe('GO');
  });
});
