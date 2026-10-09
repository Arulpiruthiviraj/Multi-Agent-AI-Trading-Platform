// LABEL: UNIT - proves the deterministic policy on hand-built idea fixtures (incl. a synthetic AUTHORIZED_QUANT_POLICY object). Decision-logic only; no DB, no scheduler, no broker.
/**
 * QuantExecutionPolicy tests (Quant-First Decision Architecture, Phase 16).
 *
 * Proves the deterministic policy: authorized + valid signals approve; every invalid
 * shape fails closed with a precise reason code; AI contradiction is advisory only;
 * consensusConfidence is never fabricated; AI is never consulted.
 *
 * Strategy ids derive from the production registry (CORE_STRATEGIES), never literals.
 * The calibration dimension uses an injected lookup — no DB needed here.
 */
import { describe, it, expect } from 'vitest';
import { evaluateQuantExecutionPolicy, type QuantPolicyIdeaInput } from './QuantExecutionPolicy';
import type { QuantStrategyAuthorization } from './QuantStrategyAuthorization';
import { CORE_STRATEGIES } from './strategies/StrategyEngine';

const STRATEGY_ID = CORE_STRATEGIES[0].id;

function authorized(): QuantStrategyAuthorization {
  return {
    authority: 'AUTHORIZED_QUANT_POLICY',
    reason: 'STRATEGY_VALIDATED',
    origin: 'QUANT_STRATEGY',
    strategyId: STRATEGY_ID,
    lifecycleStatus: 'VALIDATED',
    producerAgent: 'QuantEngine',
    paperOnlyEnforced: true,
    checkedAt: new Date().toISOString(),
  };
}

function validEvaluation(overrides: Record<string, unknown> = {}) {
  return {
    strategy: STRATEGY_ID,
    side: 'BUY',
    setupScore: 85,
    confidence: 0.8,
    triggerMet: true,
    conditionsMet: ['breakout'],
    conditionsFailed: [],
    contradictions: [],
    invalidationConditions: ['close back below breakout level'],
    stop: { price: 95, basis: 'swing low' },
    target: { price: 110, basis: 'measured move' },
    applicableRegimes: ['BULLISH_TREND'],
    ...overrides,
  };
}

function validIdea(overrides: Record<string, unknown> = {}): QuantPolicyIdeaInput {
  return {
    traceId: 'trace_test_1',
    symbol: 'AAPL',
    side: 'BUY',
    confidence: 0.8,
    reasoning: 'test breakout',
    agent: 'QuantEngine',
    currentPrice: 100,
    strategyId: STRATEGY_ID,
    origin: 'QUANT_STRATEGY',
    quantDetail: {
      strategyEvaluation: validEvaluation() as any,
      regime: { regime: 'BULLISH_TREND' },
      internalEnsemble: { rawSide: 'BUY', sideMismatch: false, qualifiesAsIndependent: true },
      dataQuality: { tradeBlocked: false, blockReason: null },
    },
    ...overrides,
  };
}

const sufficientCalibration = async () => ({ sufficient: true, sampleSize: 120 });
const insufficientCalibration = async () => ({ sufficient: false, sampleSize: 3 });
const noCalibration = async () => null;

describe('QuantExecutionPolicy', () => {
  it('approves an authorized, fully-valid quant signal without consulting AI', async () => {
    const d = await evaluateQuantExecutionPolicy(validIdea(), authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(true);
    expect(d.decisionPolicy).toBe('QUANT_EXECUTION');
    expect(d.reasonCode).toBe('QUANT_POLICY_APPROVED');
    // Phase 8: never fake consensus numbers.
    expect(d.consensusConfidence).toBeNull();
    expect(d.aiAvailability).toBe('NOT_CONSULTED');
    expect(d.strategyConfidence).toBe(0.8);
    expect(d.riskRewardRatio).toBeCloseTo(2.0, 5);
    expect(d.checks.filter((c) => c.category === 'REQUIRED').every((c) => c.passed)).toBe(true);
    expect(d.supportSatisfied).toBeGreaterThanOrEqual(d.supportRequired);
  });

  it('an AI contradiction disagreeing with the side is advisory only — still approves', async () => {
    const idea = validIdea({
      quantDetail: {
        ...(validIdea().quantDetail as object),
        aiContradictionAnalysis: { available: true, aiAgreesWithSide: false },
      },
    });
    const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(true);
    expect(d.aiAdvisoryNote).toContain('advisory only');
  });

  it('rejects when authority is not AUTHORIZED_QUANT_POLICY', async () => {
    const auth = { ...authorized(), authority: 'REQUIRES_CONSENSUS' as const, reason: 'STRATEGY_UNTESTED' as const };
    const d = await evaluateQuantExecutionPolicy(validIdea(), auth, { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_AUTHORITY_INVALID');
  });

  it('a NOT_AUTHORIZED (missing lifecycle record) authorization never enters the quant policy', async () => {
    // Defect #1 (2026-10-08): a strategy with no lifecycle record must fail closed at the
    // authorization layer AND at this policy layer — missing state gains no execution path.
    const auth = { ...authorized(), authority: 'NOT_AUTHORIZED' as const, reason: 'NO_LIFECYCLE_RECORD' as const, lifecycleStatus: null };
    const d = await evaluateQuantExecutionPolicy(validIdea(), auth, { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_AUTHORITY_INVALID');
  });

  it.each([['HOLD'], [''], [null], [undefined]])('rejects invalid side %p', async (side) => {
    const d = await evaluateQuantExecutionPolicy(validIdea({ side }), authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_SIDE_INVALID');
  });

  it.each([[NaN], [Infinity], [0], [-1], [1.5], ['0.8']])('rejects non-sane confidence %p', async (confidence) => {
    const d = await evaluateQuantExecutionPolicy(validIdea({ confidence }), authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_NUMERIC_INVALID');
  });

  it('rejects a cold-start-style idea with no strategy evaluation', async () => {
    const idea = validIdea({ quantDetail: { regime: { regime: 'BULLISH_TREND' } } });
    const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_NO_STRATEGY_EVALUATION');
  });

  it('rejects when the evaluation backs a different strategy than authorized', async () => {
    const idea = validIdea({
      quantDetail: { ...(validIdea().quantDetail as object), strategyEvaluation: validEvaluation({ strategy: 'SOME_OTHER' }) as any },
    });
    const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_STRATEGY_MISMATCH');
  });

  it('rejects when the evaluation side disagrees with the idea side', async () => {
    const idea = validIdea({
      side: 'SELL',
      quantDetail: { ...(validIdea().quantDetail as object), strategyEvaluation: validEvaluation({ side: 'BUY' }) as any },
    });
    const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_SIDE_MISMATCH');
  });

  it('rejects when the defining trigger did not fire (confirming conditions never suffice)', async () => {
    const idea = validIdea({
      quantDetail: { ...(validIdea().quantDetail as object), strategyEvaluation: validEvaluation({ triggerMet: false }) as any },
    });
    const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_TRIGGER_NOT_FIRED');
  });

  it.each([
    [{ price: 100, basis: 'x' }, 'stop == entry'],
    [{ price: null, basis: 'x' }, 'stop null'],
  ])('rejects undefined risk (stop=%p)', async (stop) => {
    const idea = validIdea({
      quantDetail: { ...(validIdea().quantDetail as object), strategyEvaluation: validEvaluation({ stop }) as any },
    });
    const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_RISK_UNDEFINED');
  });

  it('rejects when the canonical data-quality snapshot blocks', async () => {
    const idea = validIdea({
      quantDetail: { ...(validIdea().quantDetail as object), dataQuality: { tradeBlocked: true, blockReason: 'STALE' } },
    });
    const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_DATA_BLOCKED');
  });

  it('rejects an expired signal', async () => {
    const idea = validIdea({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_SIGNAL_EXPIRED');
  });

  it('2026-10-08 defect hunt (P2): malformed expiresAt fails closed (never treated as not-expired)', async () => {
    // Previously new Date(malformed).getTime() = NaN, and NaN <= Date.now() is
    // false — a garbage expiry string slipped past as "not expired" (fail-open).
    for (const bad of ['not-a-date', 'undefined', '{}', '--']) {
      const idea = validIdea({ expiresAt: bad });
      const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: sufficientCalibration });
      expect(d.approved).toBe(false);
      expect(d.reasonCode).toBe('QUANT_SIGNAL_EXPIRED');
    }
  });

  it('rejects when too few independent support dimensions hold (no fake independence)', async () => {
    // Only RISK_REWARD_ADEQUATE holds: regime mismatched, ensemble disagreeing,
    // calibration insufficient. RSI+MACD-style correlated conditions inside the strategy
    // cannot substitute — they were already counted once via TRIGGER_FIRED.
    const idea = validIdea({
      quantDetail: {
        strategyEvaluation: validEvaluation() as any,
        regime: { regime: 'BEARISH_TREND' },
        internalEnsemble: { rawSide: 'SELL', sideMismatch: true, qualifiesAsIndependent: false },
        dataQuality: { tradeBlocked: false, blockReason: null },
      },
    });
    const d = await evaluateQuantExecutionPolicy(idea, authorized(), { calibrationLookup: insufficientCalibration });
    expect(d.approved).toBe(false);
    expect(d.reasonCode).toBe('QUANT_INSUFFICIENT_SUPPORT');
    expect(d.supportSatisfied).toBeLessThan(d.supportRequired);
  });

  it('missing calibration history does not satisfy the dimension but need not block (2 of 4 still reachable)', async () => {
    const d = await evaluateQuantExecutionPolicy(validIdea(), authorized(), { calibrationLookup: noCalibration });
    // regime + ensemble + R:R = 3 >= 2 → approves without calibration data.
    expect(d.approved).toBe(true);
    expect(d.checks.find((c) => c.id === 'CALIBRATION_SUPPORTED')?.passed).toBe(false);
  });

  it('every check carries an id, category, and human-readable detail', async () => {
    const d = await evaluateQuantExecutionPolicy(validIdea(), authorized(), { calibrationLookup: sufficientCalibration });
    expect(d.checks.length).toBeGreaterThan(0);
    for (const c of d.checks) {
      expect(c.id).toMatch(/^[A-Z_]+$/);
      expect(['REQUIRED', 'SUPPORT']).toContain(c.category);
      expect(c.detail.length).toBeGreaterThan(0);
    }
  });
});
