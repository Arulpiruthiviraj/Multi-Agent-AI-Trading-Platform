import { describe, it, expect } from 'vitest';
import { computeConsensusDebateCapture } from './ConsensusDebateForensics';
import type { Evidence, AggregationResult } from './EvidenceAggregator';

function ev(agent: string, side: 'BUY' | 'SELL' | 'HOLD', confidence: number, weight: number): Evidence {
  return { traceId: 't1', symbol: 'TEST', side, confidence, agent, reasoning: 'test', weight };
}

/**
 * ConsensusDebate P0.5 forensic measurement (2026-09-13). Pure unit tests for the real
 * counterfactual computation - EvidenceAggregator.aggregate() called a second time on the SAME
 * evidence minus ConsensusDebate's own row, exactly as ChiefTraderAgent.ts does it live.
 */
describe('computeConsensusDebateCapture', () => {
  it('returns null when ConsensusDebate did not participate and there is no fail-closed event', () => {
    const evidence = [ev('QuantEngine', 'BUY', 0.8, 0.7), ev('TechnicalAgent', 'BUY', 0.7, 1.0)];
    const result: AggregationResult = { side: 'BUY', confidence: 0.82, reasoning: 'x', agreements: evidence, disagreements: [] };
    const row = computeConsensusDebateCapture({
      traceId: 't1', symbol: 'TEST', evidence, result, withDebateApproved: true,
    });
    expect(row).toBeNull();
  });

  it('classifies a real HOLD veto: base case clears threshold+independence, final does not approve -> vetoFired=true', () => {
    const debate = ev('ConsensusDebate', 'HOLD', 0.8, 0.35);
    const evidence = [
      ev('QuantEngine', 'BUY', 0.8, 0.7),
      ev('TechnicalAgent', 'BUY', 0.85, 1.258),
      debate,
    ];
    // Real weighted result WITH debate - crushed low (matches the live audit's own real samples,
    // e.g. traceId trace_GLD_1789148825_bbcf: 0.472 -> 0.251 once ConsensusDebate's HOLD applies).
    const result: AggregationResult = { side: 'BUY', confidence: 0.11, reasoning: 'x', agreements: [evidence[0], evidence[1]], disagreements: [debate] };
    const row = computeConsensusDebateCapture({
      traceId: 't1', symbol: 'TEST', evidence, result, withDebateApproved: false,
      debateTelemetry: { providers_attempted: 3, providers_succeeded: 3, providers_failed: 0 },
    });
    expect(row).not.toBeNull();
    expect(row!.debateStatus).toBe('VALID_PREDICTION');
    expect(row!.debateDirection).toBe('HOLD');
    expect(row!.baseConsensusSide).toBe('BUY');
    // Real base-case math (ConsensusDebate excluded entirely, so no hard-veto-agent penalty applies):
    // (0.8*0.7 + 0.85*1.258) / (0.7+1.258) = 1.6293/1.958 ~= 0.832 - clears 0.75.
    expect(row!.baseConsensusConfidence).toBeGreaterThan(0.75);
    expect(row!.baseClearsThreshold).toBe(true);
    expect(row!.baseClearsIndependence).toBe(true);
    expect(row!.withDebateApproved).toBe(false);
    expect(row!.vetoFired).toBe(true);
    expect(row!.underlyingAgentCount).toBe(2);
  });

  it('does NOT mark vetoFired when the base case itself would not have cleared consensus (debate is not the reason)', () => {
    const debate = ev('ConsensusDebate', 'HOLD', 0.8, 0.35);
    // Only ONE independent agent (QuantEngine) - base case fails independence regardless of debate.
    const evidence = [ev('QuantEngine', 'BUY', 0.8, 0.7), debate];
    const result: AggregationResult = { side: 'BUY', confidence: 0.3, reasoning: 'x', agreements: [evidence[0]], disagreements: [debate] };
    const row = computeConsensusDebateCapture({
      traceId: 't1', symbol: 'TEST', evidence, result, withDebateApproved: false,
      debateTelemetry: { providers_attempted: 2, providers_succeeded: 2, providers_failed: 0 },
    });
    expect(row).not.toBeNull();
    expect(row!.baseClearsIndependence).toBe(false);
    expect(row!.vetoFired).toBe(false); // debate is not the (sole) reason - independence alone would have blocked it too
  });

  it('does NOT mark vetoFired when the round was actually approved despite a debate HOLD present (e.g. QUANT_INDEPENDENT override elsewhere)', () => {
    const debate = ev('ConsensusDebate', 'HOLD', 0.8, 0.35);
    const evidence = [ev('QuantEngine', 'BUY', 0.9, 2.0), ev('TechnicalAgent', 'BUY', 0.8, 1.0), debate];
    const result: AggregationResult = { side: 'BUY', confidence: 0.8, reasoning: 'x', agreements: [evidence[0], evidence[1]], disagreements: [debate] };
    const row = computeConsensusDebateCapture({
      traceId: 't1', symbol: 'TEST', evidence, result, withDebateApproved: true, // approved via some other real path
      debateTelemetry: { providers_attempted: 1, providers_succeeded: 1, providers_failed: 0 },
    });
    expect(row!.vetoFired).toBe(false);
  });

  it('captures a directional (BUY/SELL) debate vote without ever computing vetoFired=true', () => {
    const debate = ev('ConsensusDebate', 'SELL', 0.8, 0.35);
    const evidence = [ev('QuantEngine', 'BUY', 0.8, 0.7), ev('TechnicalAgent', 'BUY', 0.7, 1.0), debate];
    const result: AggregationResult = { side: 'BUY', confidence: 0.7, reasoning: 'x', agreements: [evidence[0], evidence[1]], disagreements: [debate] };
    const row = computeConsensusDebateCapture({
      traceId: 't1', symbol: 'TEST', evidence, result, withDebateApproved: false,
      debateTelemetry: { providers_attempted: 2, providers_succeeded: 1, providers_failed: 1 },
    });
    expect(row!.debateDirection).toBe('SELL');
    expect(row!.vetoFired).toBe(false); // only ever true for a HOLD debate vote
  });

  it('captures a FAIL_CLOSED event with null debateDirection/debateConfidence, never fabricated', () => {
    const evidence = [ev('QuantEngine', 'BUY', 0.8, 0.7), ev('TechnicalAgent', 'BUY', 0.7, 1.0)];
    const result: AggregationResult = { side: 'BUY', confidence: 0.76, reasoning: 'x', agreements: evidence, disagreements: [] };
    const row = computeConsensusDebateCapture({
      traceId: 't1', symbol: 'TEST', evidence, result, withDebateApproved: true,
      failClosed: { status: 'FAIL_CLOSED_ERROR', providersAttempted: 3, providersSucceeded: 0, providersFailed: 3 },
    });
    expect(row).not.toBeNull();
    expect(row!.debateStatus).toBe('FAIL_CLOSED_ERROR');
    expect(row!.debateDirection).toBeNull();
    expect(row!.debateConfidence).toBeNull();
    expect(row!.providersFailed).toBe(3);
    expect(row!.vetoFired).toBe(false); // no vote was ever cast
  });

  it('preserves the real underlying evidence array (minus ConsensusDebate) as JSON, never fabricated or dropped', () => {
    const debate = ev('ConsensusDebate', 'HOLD', 0.8, 0.35);
    const evidence = [ev('QuantEngine', 'BUY', 0.8, 0.7), ev('KronosEngine', 'SELL', 0.5, 0.988), debate];
    const result: AggregationResult = { side: 'BUY', confidence: 0.2, reasoning: 'x', agreements: [evidence[0]], disagreements: [evidence[1], debate] };
    const row = computeConsensusDebateCapture({
      traceId: 't1', symbol: 'TEST', evidence, result, withDebateApproved: false,
      debateTelemetry: { providers_attempted: 1, providers_succeeded: 1, providers_failed: 0 },
    });
    const parsed = JSON.parse(row!.underlyingEvidenceJson);
    expect(parsed).toHaveLength(2);
    expect(parsed.find((p: any) => p.agent === 'QuantEngine').side).toBe('BUY');
    expect(parsed.find((p: any) => p.agent === 'KronosEngine').side).toBe('SELL');
    expect(parsed.some((p: any) => p.agent === 'ConsensusDebate')).toBe(false);
  });
});
