import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingEngine } from '../engines/TradingEngine';
import { setPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { tradingSafety } from '../config/tradingSafety';
import { emitJavaCoreEnsembleVoteIfEligible } from './JavaCoreEnsembleVoteService';
import type { CoreEnsembleDecision } from './QuantCoreBridge';
import { marketDataWorker } from './MarketDataWorker';
import {
  setObservabilityPersistForTests,
  resetObservabilityStoreForTests,
  flushObservabilityStore,
  type ObservabilityEventRow,
} from '../observability/ObservabilityStore';
import { emitQuantEvidenceObservability } from '../observability/quantEvidenceEmitter';

vi.mock('../observability/quantEvidenceEmitter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../observability/quantEvidenceEmitter')>();
  return { ...actual, emitQuantEvidenceObservability: vi.fn(actual.emitQuantEvidenceObservability) };
});

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
    vi.spyOn(marketDataWorker, 'getLatestPrice').mockReturnValue(190);
    vi.spyOn(marketDataWorker, 'getLatestPriceAgeMs').mockReturnValue(0);
    process.env[FLAG] = 'true';
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    setPipelineAgentEnabled('JavaCoreEnsemble', true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    vi.mocked(marketDataWorker.getLatestPrice).mockReturnValue(410);
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

  it.each([null, -1, Number.NaN, tradingSafety.stalePriceThresholdMs + 1])(
    'does not emit from historical price when current quote age is %s', (age) => {
      vi.mocked(marketDataWorker.getLatestPriceAgeMs).mockReturnValue(age);
      const emit = vi.spyOn(eventBus, 'emitTradeIdea');
      expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190))
        .toEqual({ emitted: false, reason: 'MARKET_DATA_UNAVAILABLE' });
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it.each([null, 0, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid observed price %s', (price) => {
    vi.mocked(marketDataWorker.getLatestPrice).mockReturnValue(price);
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190).emitted).toBe(false);
  });

  it('uses the fresh observed price rather than the historical close supplied by the caller', () => {
    vi.mocked(marketDataWorker.getLatestPrice).mockReturnValue(191.25);
    const emit = vi.spyOn(eventBus, 'emitTradeIdea');
    expect(emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 180).emitted).toBe(true);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ currentPrice: 191.25 }));
  });

  describe('QuantEvidence observability (Milestone B.1, 2026-09-23)', () => {
    let captured: ObservabilityEventRow[];

    beforeEach(() => {
      captured = [];
      resetObservabilityStoreForTests();
      setObservabilityPersistForTests(async (batch) => { captured.push(...batch); });
    });

    afterEach(async () => {
      await flushObservabilityStore();
      setObservabilityPersistForTests(null);
      resetObservabilityStoreForTests();
    });

    it('emits a real QUANT_EVIDENCE_PRODUCED row on a vote-eligible path, with correct payload shape', async () => {
      const result = emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190);
      expect(result).toEqual({ emitted: true, reason: 'EMITTED' });
      await flushObservabilityStore();

      const row = captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED');
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload as string);
      expect(payload.producer).toBe('JavaCoreEnsemble');
      expect(payload.methodologyFamily).toBe('TECHNICAL_ENSEMBLE');
      expect(payload.direction).toBe('BUY');
      expect(payload.confidence).toEqual({ value: 0.65, provenance: 'REAL_VALUE' });
      expect(row!.symbol).toBe('AAPL');
    });

    it('still emits QUANT_EVIDENCE_PRODUCED even when the vote itself does not fire (e.g. HOLD direction) - the observability leaf reflects every evaluated decision, not only successful votes', async () => {
      const result = emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble({ direction: 'HOLD' }), 190);
      expect(result).toEqual({ emitted: false, reason: 'HOLD_DIRECTION' });
      await flushObservabilityStore();

      const row = captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED');
      expect(row).toBeDefined();
      expect(JSON.parse(row!.payload as string).direction).toBe('HOLD');
    });

    it('does NOT emit QUANT_EVIDENCE_PRODUCED when the JavaCoreEnsemble Mission Control toggle is off (AGENT_DISABLED is never bypassed for observability)', async () => {
      setPipelineAgentEnabled('JavaCoreEnsemble', false);
      const result = emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190);
      expect(result).toEqual({ emitted: false, reason: 'AGENT_DISABLED' });
      await flushObservabilityStore();

      expect(captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED')).toBeUndefined();
    });

    it('leaves unsupported fields honestly NULL_NOT_SUPPORTED / NOT_YET_CALIBRATED in the emitted event - never silently filled', async () => {
      emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190);
      await flushObservabilityStore();

      const payload = JSON.parse(captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED')!.payload as string);
      expect(payload.predictedReturn).toEqual({ value: null, provenance: 'NULL_NOT_SUPPORTED' });
      expect(payload.probabilityUp).toEqual({ value: null, provenance: 'NULL_NOT_SUPPORTED' });
      expect(payload.calibrationSampleSize).toEqual({ value: null, provenance: 'NOT_YET_CALIBRATED' });
      expect(payload.calibrationStatus).toBe('NOT_YET_CALIBRATED');
      expect(payload.dataFreshness).toEqual({ value: null, provenance: 'NULL_NOT_SUPPORTED' });
    });

    it('suppresses the event (no QUANT_EVIDENCE_PRODUCED row, no throw) when the mapped evidence contains a non-finite number', async () => {
      // Exercise the real emitter directly (not the mocked wrapper) with a NaN-poisoned evidence
      // object built from the same real adapter, proving suppression end-to-end.
      const { mapJavaCoreEnsembleToQuantEvidence } = await import('../quant/quantEvidenceAdapters');
      const { emitQuantEvidenceObservability: realEmit } = await vi.importActual<typeof import('../observability/quantEvidenceEmitter')>('../observability/quantEvidenceEmitter');
      const evidence = mapJavaCoreEnsembleToQuantEvidence(ensemble());
      const poisoned = { ...evidence, confidence: { value: Number.NaN, provenance: 'REAL_VALUE' as const } };
      expect(() => realEmit('AAPL', poisoned as any)).not.toThrow();
      await flushObservabilityStore();

      expect(captured.find((r) => r.eventType === 'QUANT_EVIDENCE_PRODUCED')).toBeUndefined();
      const warnRow = captured.find((r) => r.eventType === 'QUANT_EVIDENCE_VALIDATION_FAILED');
      expect(warnRow).toBeDefined();
    });

    it('does NOT prevent the vote decision from completing normally when the observability path throws (the single most important guarantee of this milestone)', () => {
      vi.mocked(emitQuantEvidenceObservability).mockImplementationOnce(() => {
        throw new Error('forced observability failure');
      });
      const ideas: any[] = [];
      const onIdea = (p: any) => ideas.push(p);
      eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
      try {
        expect(() => emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190)).not.toThrow();
        const result = emitJavaCoreEnsembleVoteIfEligible('AAPL', ensemble(), 190);
        expect(result).toEqual({ emitted: true, reason: 'EMITTED' });
      } finally {
        eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
      }
    });
  });
});
