/**
 * Phase 40 — Jev AI value: advisory evidence is observable, advisory authority is zero.
 *
 * === SYNTHETIC_SEEDED / NON_ORGANIC ===
 *
 * TWO PROPERTIES:
 *  A. (RUNS TODAY — no sibling contract needed) Against the REAL evaluateQuantExecutionPolicy:
 *     a Jev-shaped advisory (material-news catalyst classification: relevant=0.9,
 *     materiality=4/5, disagreeing with the quant side) attached to a valid quant idea
 *     changes NOTHING about the policy decision — {approved, decisionPolicy, reasonCode,
 *     supportSatisfied} are identical with and without the advisory — while the advisory
 *     evidence IS observable in the decision's aiAdvisoryNote. Advisory: zero authority,
 *     full observability. aiAvailability stays 'NOT_CONSULTED', consensusConfidence stays null.
 *  B. (SKIPPED until AICallGovernor lands) The material-news scenario end to end: a mocked
 *     Jev returning the catalyst classification through governor.request() ->
 *     the structured decision is observable on the governor result; feeding it through the
 *     sanctioned advisory channel into the real policy yields the identical decision as the
 *     no-advisory run.
 *
 * Fixture builders are mirrored from src/server/quant/QuantExecutionPolicy.test.ts (the
 * Phase 16 policy suite) — same authorized() shape, same validEvaluation/validIdea shape,
 * same injected calibration lookup (no DB). Strategy id derives from CORE_STRATEGIES, per
 * the repo rule against strategy-id literals.
 */
import { describe, it, expect } from 'vitest';
import { evaluateQuantExecutionPolicy, type QuantPolicyIdeaInput } from '../quant/QuantExecutionPolicy';
import type { QuantStrategyAuthorization } from '../quant/QuantStrategyAuthorization';
import { CORE_STRATEGIES } from '../quant/strategies/StrategyEngine';

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
    traceId: 'trace_jev_aivalue',
    symbol: 'AAPL',
    side: 'BUY',
    confidence: 0.8,
    reasoning: 'SYNTHETIC_SEEDED (NON_ORGANIC): valid quant breakout idea.',
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

/** A Jev-shaped advisory: material-news catalyst classification disagreeing with the side. */
function jevAdvisory(aiAgreesWithSide: boolean) {
  return {
    available: true,
    aiAgreesWithSide,
    // Jev structured-decision payload (relevant=0.9, materiality=4/5) carried on the
    // advisory channel — the policy reads only available/aiAgreesWithSide; the rest is
    // evidence for operators, never an input to the decision math.
    jevCatalyst: { relevant: 0.9, materiality: 4, classification: 'CATALYST_BULLISH' },
    source: 'SYNTHETIC_SEEDED Jev mock',
  };
}

const sufficientCalibration = async () => ({ sufficient: true, sampleSize: 120 });

function decisionFingerprint(d: { approved: boolean; decisionPolicy: unknown; reasonCode: unknown; supportSatisfied: unknown }) {
  return {
    approved: d.approved,
    decisionPolicy: d.decisionPolicy,
    reasonCode: d.reasonCode,
    supportSatisfied: d.supportSatisfied,
  };
}

describe('Jev AI value: advisory evidence observable, advisory authority zero (SYNTHETIC_SEEDED)', () => {
  it('quant decision is IDENTICAL with and without a disagreeing Jev advisory; the advisory is observable in aiAdvisoryNote', async () => {
    const without = await evaluateQuantExecutionPolicy(validIdea(), authorized(), {
      calibrationLookup: sufficientCalibration,
    });
    expect(without.approved).toBe(true);
    expect(without.aiAdvisoryNote).toBeNull(); // no advisory attached -> no note

    const withAdvisory = await evaluateQuantExecutionPolicy(
      validIdea({
        quantDetail: { ...(validIdea().quantDetail as object), aiContradictionAnalysis: jevAdvisory(false) as any },
      }),
      authorized(),
      { calibrationLookup: sufficientCalibration },
    );

    // Zero authority: the decision fingerprint is byte-identical.
    expect(decisionFingerprint(withAdvisory)).toEqual(decisionFingerprint(without));
    // Full observability: the advisory evidence is present in the decision record...
    expect(withAdvisory.aiAdvisoryNote).not.toBeNull();
    expect(withAdvisory.aiAdvisoryNote).toContain('advisory only');
    // ...while the policy still records that AI was never consulted and no consensus ran.
    expect(withAdvisory.aiAvailability).toBe('NOT_CONSULTED');
    expect(withAdvisory.consensusConfidence).toBeNull();
    console.log(
      `[jev-ai-value] disagreeing advisory: decision unchanged ${JSON.stringify(decisionFingerprint(withAdvisory))}, ` +
      `note=${JSON.stringify(withAdvisory.aiAdvisoryNote)}`,
    );
  });

  it('an AGREEING Jev advisory likewise has zero authority (advisory cannot boost either)', async () => {
    const without = await evaluateQuantExecutionPolicy(validIdea(), authorized(), {
      calibrationLookup: sufficientCalibration,
    });
    const withAgreeing = await evaluateQuantExecutionPolicy(
      validIdea({
        quantDetail: { ...(validIdea().quantDetail as object), aiContradictionAnalysis: jevAdvisory(true) as any },
      }),
      authorized(),
      { calibrationLookup: sufficientCalibration },
    );
    expect(decisionFingerprint(withAgreeing)).toEqual(decisionFingerprint(without));
    expect(withAgreeing.approved).toBe(true);
    console.log(`[jev-ai-value] agreeing advisory: decision unchanged ${JSON.stringify(decisionFingerprint(withAgreeing))}`);
  });

  describe('material-news scenario through the governor (AICallGovernor)', () => {
    it('mocked Jev catalyst classification is observable AND leaves the quant decision identical', async () => {
      const { AICallGovernor } = await import('./AICallGovernor');
      const governor = AICallGovernor.getInstance();
      governor.resetForTests();
      try {
        let providerInvocations = 0;
        governor.__setJevProviderForTests({
          isConfigured: () => true,
          decide: async () => {
            providerInvocations++;
            return {
              answers: {
                relevant: { type: 'noul', noul: 0.9 },
                materiality: { type: 'score', score: 4, legend: { '4': 'material' }, probabilities: { '4': 0.8 }, confidence: 0.85 },
                classification: { type: 'choice', choice: 'CATALYST_BULLISH', probabilities: { CATALYST_BULLISH: 0.9 }, confidence: 0.9 },
              },
              model: 'jev-synthetic',
              inputTokens: 10,
              latencyMs: 1,
            };
          },
        });

        const res = await governor.request({
          capability: 'STRUCTURED_DECISION',
          kind: 'news_catalyst_triage',
          material: {
            symbol: 'AAPL',
            fingerprintParts: { event: 'synthetic-material-news', symbol: 'AAPL' },
            materiality: 'HIGH',
            decisionDeadlineMs: Date.now() + 60_000,
            traceId: 'synthetic-ai-value-1',
          },
          jev: {
            state: { synthetic: true },
            questions: { material: 'is this catalyst material?' },
            schemaVersion: '1',
          },
          run: async () => ({ value: null, cacheable: false }),
        });
        expect(['CALLED', 'CACHE_HIT']).toContain(res.status);
        // Advisory evidence observable on the governor result: the structured decision.
        const answers = (res as any).result?.answers ?? (res as any).result;
        expect(answers.relevant).toMatchObject({ type: 'noul', noul: 0.9 });
        expect(answers.materiality).toMatchObject({ type: 'score', score: 4 });
        expect(answers.classification).toMatchObject({ type: 'choice', choice: 'CATALYST_BULLISH' });
        console.log(
          `[jev-ai-value] governor result: status=${res.status}, ` +
          `invocations=${providerInvocations}, answers=${JSON.stringify(answers)}`,
        );

        // The quant decision with that advisory attached is identical to without it.
        const without = await evaluateQuantExecutionPolicy(validIdea(), authorized(), {
          calibrationLookup: sufficientCalibration,
        });
        const withAdvisory = await evaluateQuantExecutionPolicy(
          validIdea({
            quantDetail: {
              ...(validIdea().quantDetail as object),
              aiContradictionAnalysis: {
                available: true,
                aiAgreesWithSide: false,
                jevCatalyst: answers,
              } as any,
            },
          }),
          authorized(),
          { calibrationLookup: sufficientCalibration },
        );
        expect(decisionFingerprint(withAdvisory)).toEqual(decisionFingerprint(without));
        expect(withAdvisory.aiAdvisoryNote).toContain('advisory only');
      } finally {
        governor.resetForTests();
      }
    });

    it('the governor round-trip suite is live: AICallGovernor contract present', async () => {
      const { AICallGovernor } = await import('./AICallGovernor');
      const governor = AICallGovernor.getInstance();
      expect(typeof governor.request).toBe('function');
      expect(typeof governor.__setJevProviderForTests).toBe('function');
    });
  });
});
