/**
 * InstitutionalStrategyVoteService.test.ts
 *
 * Tests the vote gating chain for the 2026-10-05 institutional paper-verification wiring.
 * No network, no timers - emitVoteIfEligible is the pure decision function.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { institutionalStrategyVoteService, INSTITUTIONAL_VOTE_STRATEGIES } from './InstitutionalStrategyVoteService';
import { tradingEngine } from '../engines/TradingEngine';
import { setPipelineAgentEnabled } from '../core/pipelineAgentGate';

const SPEC = INSTITUTIONAL_VOTE_STRATEGIES[0]; // VolScaledMtfMomentum

function evaluation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    strategyId: SPEC.strategyId,
    symbol: 'AAPL',
    side: 'BUY',
    setupScore: 4,
    confidence: 0.7, // clears the default javaQuantVoteMinConfidence (0.6)
    triggerMet: true,
    conditionsMet: ['fast-drift positive', 'slow-drift positive'],
    conditionsFailed: [],
    contradictions: [],
    invalidationConditions: [],
    applicableRegimes: [],
    ...overrides,
  };
}

describe('InstitutionalStrategyVoteService gating (2026-10-05 paper-verification wiring)', () => {
  beforeEach(() => {
    process.env[SPEC.envVar] = 'true';
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    setPipelineAgentEnabled(SPEC.agentName, true);
  });

  afterEach(() => {
    delete process.env[SPEC.envVar];
    setPipelineAgentEnabled(SPEC.agentName, true);
  });

  it('does nothing (FLAG_OFF) when the strategy env flag is not true', () => {
    delete process.env[SPEC.envVar];
    expect(institutionalStrategyVoteService.emitVoteIfEligible('AAPL', SPEC, evaluation(), 190))
      .toEqual({ emitted: false, reason: 'FLAG_OFF' });
  });

  it('does nothing (AGENT_DISABLED) when the Mission Control toggle is off', () => {
    setPipelineAgentEnabled(SPEC.agentName, false);
    expect(institutionalStrategyVoteService.emitVoteIfEligible('AAPL', SPEC, evaluation(), 190))
      .toEqual({ emitted: false, reason: 'AGENT_DISABLED' });
  });

  it('does nothing (TRIGGER_NOT_MET) when Java says the entry trigger did not fire', () => {
    expect(institutionalStrategyVoteService.emitVoteIfEligible('AAPL', SPEC, evaluation({ triggerMet: false }), 190))
      .toEqual({ emitted: false, reason: 'TRIGGER_NOT_MET' });
  });

  it('does nothing (NEUTRAL_SIDE) on HOLD/NEUTRAL evaluations', () => {
    expect(institutionalStrategyVoteService.emitVoteIfEligible('AAPL', SPEC, evaluation({ side: 'HOLD' }), 190))
      .toEqual({ emitted: false, reason: 'NEUTRAL_SIDE' });
  });

  it('does nothing (BELOW_MIN_CONFIDENCE) under the shared 0.6 floor', () => {
    expect(institutionalStrategyVoteService.emitVoteIfEligible('AAPL', SPEC, evaluation({ confidence: 0.59 }), 190))
      .toEqual({ emitted: false, reason: 'BELOW_MIN_CONFIDENCE' });
  });

  it('does nothing (INVALID_PRICE) on missing/zero price', () => {
    expect(institutionalStrategyVoteService.emitVoteIfEligible('AAPL', SPEC, evaluation(), null))
      .toEqual({ emitted: false, reason: 'INVALID_PRICE' });
    expect(institutionalStrategyVoteService.emitVoteIfEligible('AAPL', SPEC, evaluation(), 0))
      .toEqual({ emitted: false, reason: 'INVALID_PRICE' });
  });

  it('does nothing (JAVA_ERROR) when the bridge returns null', () => {
    expect(institutionalStrategyVoteService.emitVoteIfEligible('AAPL', SPEC, null, 190))
      .toEqual({ emitted: false, reason: 'JAVA_ERROR' });
  });

  it('emits one independent vote when all gates pass', () => {
    const res = institutionalStrategyVoteService.emitVoteIfEligible('AAPL', SPEC, evaluation(), 190);
    expect(res).toEqual({ emitted: true, reason: 'EMITTED' });
  });

  it('registers exactly the three single-symbol institutional strategies (StatArb excluded)', () => {
    const ids = INSTITUTIONAL_VOTE_STRATEGIES.map((s) => s.strategyId).sort();
    expect(ids).toEqual([
      'INSTITUTIONAL_MULTI_FACTOR_MOMENTUM',
      'INSTITUTIONAL_TS_MOMENTUM_12M',
      'INSTITUTIONAL_VOL_SCALED_MTF_MOMENTUM',
    ]);
  });
});
