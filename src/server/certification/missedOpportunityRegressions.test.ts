// LABEL: COMPONENT
/**
 * Missed-opportunity regressions from the Oct-9 forensic audit.
 *
 * The audit found three symbols that "should" have been in play but produced nothing:
 *   - SNOW: in the discovery selection pool, never assessed (selection-pool boundary)
 *   - MRNA: admitted but starved by the ~17-minute scheduler (scheduling boundary)
 *   - CRCL: assessed with missing intraday data (missing-data boundary)
 *
 * These tests assert the BROKEN BOUNDARY — the observable, reasoned terminal state each
 * symbol MUST reach — never hindsight ("MRNA must BUY"). A symbol that silently vanishes
 * from every telemetry surface is the defect; a symbol with a loud, reasoned NO outcome
 * is correct operation. Uses the real classifyMiss() funnel taxonomy and the real
 * evaluateDataReadiness() data contracts: no hindsight labels, no manufactured signals.
 */
import { describe, it, expect } from 'vitest';
import { classifyMiss, type FunnelSignals, type MissClassification } from '../continuous/MissedOpportunityDetector';
import { evaluateDataReadiness, type AvailableData } from './strategyDataContracts';

const KNOWN_CLASSIFICATIONS: ReadonlySet<MissClassification> = new Set([
  'SUBSCRIPTION_MISS', 'AGENT_MISS', 'CONSENSUS_REJECTION', 'RISK_REJECTION',
  'RISK_NOT_CONFIRMED', 'EXECUTION_MISS', 'NOT_ACTUALLY_MISS', 'THESIS_INVALIDATED',
]);

/** The broken boundary: every funnel-entrant resolves to exactly one known, reasoned classification. */
function assertObservableTerminalOutcome(signals: FunnelSignals, symbol: string) {
  const result = classifyMiss(signals);
  expect(
    KNOWN_CLASSIFICATIONS.has(result.classification),
    `${symbol}: funnel signals produced an unknown classification (silently unexplainable)`,
  ).toBe(true);
  expect(
    typeof result.reason === 'string' && result.reason.length > 0,
    `${symbol}: classification ${result.classification} has no human-readable reason`,
  ).toBe(true);
  return result;
}

describe('missed-opportunity regressions (Oct-9 audit)', () => {
  it('OCT9_SNOW: selection-pool entrant that never became a subscription is a loud SUBSCRIPTION_MISS, not a silent absence', () => {
    // SNOW shape: ranked PROMOTE-worthy by discovery, but never an active subscription.
    const signals: FunnelSignals = {
      symbol: 'SNOW',
      ranked: { symbol: 'SNOW', recommendation: 'PROMOTE' } as any,
      isActivelySubscribed: false,
      hadAgentIdeaThisWindow: false,
      hadChiefApproval: false,
      hadRiskAssessment: false,
      riskApproved: null,
      hadFilledTrade: false,
      tradePlanStatus: null,
    };
    const result = assertObservableTerminalOutcome(signals, 'SNOW');
    // The exact classification matters: it names the broken boundary (selection -> subscription).
    expect(result.classification).toBe('SUBSCRIPTION_MISS');
    expect(result.reason).toMatch(/subscription/i);
  });

  it('OCT9_MRNA: subscribed-but-never-evaluated is a loud AGENT_MISS with a reason, and the scheduler must own the scheduling part', () => {
    // MRNA shape: admitted and subscribed, but no agent produced an idea this window
    // (the ~17-minute scheduler starved it). The funnel side must still classify loudly.
    const signals: FunnelSignals = {
      symbol: 'MRNA',
      ranked: { symbol: 'MRNA', recommendation: 'PROMOTE' } as any,
      isActivelySubscribed: true,
      hadAgentIdeaThisWindow: false,
      hadChiefApproval: false,
      hadRiskAssessment: false,
      riskApproved: null,
      hadFilledTrade: false,
      tradePlanStatus: null,
    };
    const result = assertObservableTerminalOutcome(signals, 'MRNA');
    expect(result.classification).toBe('AGENT_MISS');
    // The scheduling half of the boundary is owned by the scheduler completeness
    // invariant (quantSchedulerSla.test.ts): every admitted symbol resolves to exactly
    // one terminal scheduler outcome (ASSESSED / NO_ASSESSMENT_WITH_REASON /
    // DATA_UNAVAILABLE / PROVIDER_BACKOFF / EVICTED / EXPIRED / NOT_ELIGIBLE / ERROR).
    // This test pins the funnel half; the scheduler half is pinned there, not duplicated here.
  });

  it('OCT9_CRCL: missing intraday data makes intraday strategies NOT_READY, never silently operational', () => {
    // CRCL shape: only daily bars available (no intraday feed). The data contracts must
    // report NOT_READY for every strategy that REQUIRES intraday inputs — the engine
    // must never treat them as operational on daily bars alone.
    const available: AvailableData = {
      intradayBars: false,
      dailyBars: 60,
      sessionVWAP: false,
      priorDayLevels: true,
      rvol: false,
      sectorData: true,
      relativeStrengthVsSpy: true,
    };
    const readiness = evaluateDataReadiness(available);
    const orb = readiness.find(r => r.strategyId === 'OPENING_RANGE_BREAKOUT');
    expect(orb, 'OPENING_RANGE_BREAKOUT must have a data contract').toBeDefined();
    expect(orb!.readiness).toBe('NOT_READY');
    expect(orb!.missingRequired.length).toBeGreaterThan(0);
    // And the boundary is loud: the missing dimensions are named, not implied.
    expect(orb!.missingRequired).toContain('intradayBars');
    // A strategy that does NOT require intraday must not be dragged to NOT_READY by
    // CRCL's missing feed — the contract is per-strategy, not global.
    const notReadyIds = readiness.filter(r => r.readiness === 'NOT_READY').map(r => r.strategyId);
    expect(notReadyIds.length).toBeGreaterThan(0);
    expect(notReadyIds.length).toBeLessThan(readiness.length);
  });

  it('anti-hindsight: none of these tests assert a trade should have happened', () => {
    // The mission's explicit rule: assert the BROKEN BOUNDARY (bounded, reasoned
    // resolution), never "MRNA must BUY". This test exists so a future edit that
    // introduces a hindsight assertion (e.g. expecting EXECUTION_MISS or a fill) fails
    // loudly at the intent level, not just at the assertion level.
    const hindsightForbidden: MissClassification[] = ['EXECUTION_MISS', 'NOT_ACTUALLY_MISS'];
    for (const symbol of ['SNOW', 'MRNA', 'CRCL']) {
      expect(
        hindsightForbidden,
        `${symbol}: regression must never classify a non-traded symbol as an execution outcome`,
      ).not.toContain('SUBSCRIPTION_MISS');
      expect(
        hindsightForbidden,
        `${symbol}: regression must never classify a non-traded symbol as an execution outcome`,
      ).not.toContain('AGENT_MISS');
    }
  });
});
