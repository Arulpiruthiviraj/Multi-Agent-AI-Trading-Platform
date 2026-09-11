import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingEngine } from '../engines/TradingEngine';
import { setPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { tradingSafety } from '../config/tradingSafety';
import { emitJavaCoreEnsembleVoteIfEligible } from './JavaCoreEnsembleVoteService';
import type { CoreEnsembleDecision } from './QuantCoreBridge';

describe('emitJavaCoreEnsembleVoteIfEligible (2026-09-10, explicit operator override)', () => {
  const FLAG = 'ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED';

  function ensemble(overrides: Partial<CoreEnsembleDecision> = {}): CoreEnsembleDecision {
    return {
      schemaVersion: 1,
      status: 'HEALTHY',
      direction: 'BUY',
      score: 0.7,
      confidence: 0.65, // clears the default javaCoreEnsembleVoteMinConfidence (0.6)
      reason: 'RangeReversion+TrendFollowing agree',
      regime: 'TRENDING',
      timestampMs: Date.now(),
      featureVersion: 'v1',
      strategyVersion: 'v1',
      strategyCount: 5,
      agreeingCount: 2,
      effectiveIndependentCount: 1.8,
      contributingStrategies: ['RANGE_REVERSION', 'TREND_FOLLOWING'],
      contributingFamilies: ['reversion', 'trend'],
      ...overrides,
    } as CoreEnsembleDecision;
  }

  beforeEach(() => {
    process.env[FLAG] = 'true';
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    setPipelineAgentEnabled('JavaCoreEnsemble', true);
  });

  afterEach(() => {
    delete process.env[FLAG];
    setPipelineAgentEnabled('JavaCoreEnsemble', true); // restore default for other test files
  });

  it('does nothing (FLAG_OFF) when ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED is not true', () => {
    delete process.env[FLAG];
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190)).toEqual({ emitted: false, reason: 'FLAG_OFF' });
  });

  it('does nothing (AGENT_DISABLED) when the JavaCoreEnsemble Mission Control toggle is off', () => {
    setPipelineAgentEnabled('JavaCoreEnsemble', false);
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190)).toEqual({ emitted: false, reason: 'AGENT_DISABLED' });
  });

  it('does nothing (IDEA_GENERATION_GATED) when Autobot is off', () => {
    tradingEngine.state.enabled = false;
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190)).toEqual({ emitted: false, reason: 'IDEA_GENERATION_GATED' });
  });

  it('does nothing (NOT_HEALTHY) when Java reports DEGRADED, even with a real directional call', () => {
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble({ status: 'DEGRADED' }), 190)).toEqual({ emitted: false, reason: 'NOT_HEALTHY' });
  });

  it('does nothing (NOT_HEALTHY) when Java reports UNAVAILABLE - insufficient bar history is never conflated with a directional HOLD', () => {
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble({ status: 'UNAVAILABLE' }), 190)).toEqual({ emitted: false, reason: 'NOT_HEALTHY' });
  });

  it('does nothing (HOLD_DIRECTION) when the ensemble found no majority side', () => {
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble({ direction: 'HOLD' }), 190)).toEqual({ emitted: false, reason: 'HOLD_DIRECTION' });
  });

  it('does nothing (BELOW_MIN_CONFIDENCE) when confidence has not cleared javaCoreEnsembleVoteMinConfidence', () => {
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble({ confidence: tradingSafety.javaCoreEnsembleVoteMinConfidence - 0.01 }), 190))
      .toEqual({ emitted: false, reason: 'BELOW_MIN_CONFIDENCE' });
  });

  it('does nothing (INVALID_PRICE) when no current price is available - never fabricates one', () => {
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), null)).toEqual({ emitted: false, reason: 'INVALID_PRICE' });
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 0)).toEqual({ emitted: false, reason: 'INVALID_PRICE' });
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), -5)).toEqual({ emitted: false, reason: 'INVALID_PRICE' });
  });

  it('emits exactly one real TRADE_IDEA_GENERATED, as agent JavaCoreEnsemble, when every gate clears', () => {
    const ideas: any[] = [];
    const onIdea = (p: any) => ideas.push(p);
    eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    try {
      const result = emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190);
      expect(result).toEqual({ emitted: true, reason: 'EMITTED' });
      expect(ideas.length).toBe(1);
      expect(ideas[0]).toMatchObject({
        symbol: 'AAPL',
        side: 'BUY',
        confidence: 0.65,
        currentPrice: 190,
        agent: 'JavaCoreEnsemble',
      });
      expect(ideas[0].evidence.contributingStrategies).toEqual(['RANGE_REVERSION', 'TREND_FOLLOWING']);
    } finally {
      eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    }
  });

  it('emits a real SELL vote with the SELL direction and confidence carried through unchanged', () => {
    const ideas: any[] = [];
    const onIdea = (p: any) => ideas.push(p);
    eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    try {
      const result = emitJavaCoreEnsembleVoteIfEligible('MSFT', ensemble({ direction: 'SELL', confidence: 0.8 }), 410);
      expect(result).toEqual({ emitted: true, reason: 'EMITTED' });
      expect(ideas[0]).toMatchObject({ symbol: 'MSFT', side: 'SELL', confidence: 0.8, currentPrice: 410 });
    } finally {
      eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    }
  });
});
