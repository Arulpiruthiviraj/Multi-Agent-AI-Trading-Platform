import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AICallGovernor, JevDecisionResult } from '../ai/AICallGovernor';
import { aiCallGovernor } from '../config/aiCallGovernor';
import {
  kickOffJevShadowScoring,
  buildJevNewsState,
  JevNewsDeterministicContext,
} from './JevNewsTriage';
import { NormalizedArticle } from './NewsNormalizer';

/**
 * D2 (P1-latent, provider-resilience audit) regression coverage:
 * kickOffJevShadowScoring() must route through AICallGovernor (STRUCTURED_DECISION),
 * not call JevProvider.evaluate() directly. With the flag on, a news flood must be
 * bounded by the governor's budgets and concurrency cap - never unbounded
 * fire-and-forget provider calls - while keeping fire-and-forget/never-throw
 * semantics and a write-only, neutral shadow ledger.
 *
 * No network: the governor's Jev handle is faked via __setJevProviderForTests().
 * Thresholds are derived from the same config production loads (AGENTS.md rule).
 */

const BASE_ARTICLE: NormalizedArticle = {
  id: 'art-1',
  title: 'Acme beats Q3 revenue expectations',
  content: 'Acme Corp reported Q3 revenue of $2.1B vs $1.9B expected, raising full-year guidance.',
  url: 'https://example.com/news/1',
  source: 'ExampleWire',
  author: 'J. Reporter',
  publishedAt: new Date(Date.now() - 3600_1000).toISOString(),
  symbols: ['ACME'],
  fingerprint: 'fp-1',
};

const BASE_CTX: JevNewsDeterministicContext = {
  category: 'Earnings',
  credibility: 0.8,
  isNewCluster: true,
  priorArticleCount: 0,
  impactScore01: 0.7,
  timeHorizon: 'short',
};

const FAKE_ANSWERS: JevDecisionResult = {
  answers: {
    is_relevant: { type: 'noul', noul: 0.95 },
    sentiment: { type: 'choice', choice: 'bullish', confidence: 0.82, probabilities: { bullish: 0.82, bearish: 0.1, neutral: 0.08 } },
    market_impact: { type: 'score', score: 3, confidence: 0.7 },
    is_surprise: { type: 'noul', noul: 0.6 },
    has_contradiction: { type: 'noul', noul: 0.05 },
    urgency: { type: 'score', score: 2, confidence: 0.65 },
  } as unknown as JevDecisionResult['answers'],
  model: 'jev-test',
  inputTokens: 400,
  latencyMs: 25,
};

/** Letter-only tickers (looksLikeListedTicker: 1-5 uppercase letters). */
function tickerFor(i: number): string {
  const a = String.fromCharCode(65 + Math.floor(i / 26) % 26);
  const b = String.fromCharCode(65 + (i % 26));
  return `Q${a}${b}`;
}

describe('kickOffJevShadowScoring via AICallGovernor (D2)', () => {
  const FLAG = process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
  let active = 0;
  let maxActive = 0;
  let settled = 0;

  function fakeJevHandle() {
    return {
      isConfigured: () => true,
      decide: async (_req: unknown): Promise<JevDecisionResult> => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return FAKE_ANSWERS;
        } finally {
          active--;
          settled++;
        }
      },
    };
  }

  beforeEach(() => {
    process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = 'true';
    active = 0;
    maxActive = 0;
    settled = 0;
    const governor = AICallGovernor.getInstance();
    governor.resetForTests();
    governor.__setJevProviderForTests(fakeJevHandle());
  });

  afterEach(() => {
    if (FLAG === undefined) delete process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
    else process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = FLAG;
    AICallGovernor.getInstance().resetForTests();
  });

  it('a news flood is bounded: budget enforced, concurrency capped, every article accounted for', async () => {
    const N = 40; // well above the jev per-minute budget and the concurrency capacity
    const governor = AICallGovernor.getInstance();

    for (let i = 0; i < N; i++) {
      const symbol = tickerFor(i);
      const article = { ...BASE_ARTICLE, fingerprint: `flood-fp-${i}`, symbols: [symbol] };
      // Sanity: every generated input passes the perfect-data contract (else the
      // flood would trivially fail closed before reaching the governor).
      expect(buildJevNewsState(article, symbol, BASE_CTX)).not.toBeNull();
      expect(() =>
        kickOffJevShadowScoring({
          article,
          symbol,
          traceId: `trace-flood-${i}`,
          llmAnalysis: null,
          deterministic: BASE_CTX,
        }),
      ).not.toThrow();
    }

    // kickOff is fire-and-forget: wait for every in-flight score to settle.
    const deadline = Date.now() + 20_000;
    while (settled < N && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const diag = governor.getDiagnostics();
    const skipped = Object.values(diag.skips).reduce((a, b) => a + b, 0);

    // Budget enforced: no more Jev executions than the configured per-minute budget
    // (and the global optional-AI budget), however many articles arrived.
    expect(diag.called).toBe(
      Math.min(N, aiCallGovernor.jevCallsPerMinute, aiCallGovernor.aiGlobalOptionalCallsPerMinute),
    );
    // Concurrency bounded: never more simultaneous provider calls than the
    // governor's in-flight capacity (maxInFlight + queueLimit), not N.
    expect(maxActive).toBeLessThanOrEqual(aiCallGovernor.jevMaxInFlight + aiCallGovernor.jevQueueLimit);
    expect(maxActive).toBeLessThan(N);
    // Neutral failure semantics preserved: every article was either scored or
    // governor-skipped (observation dropped) - none lost, none threw.
    expect(diag.called + skipped).toBe(N);
  }, 30_000);

  it('a governor-skipped article stays neutral: no throw, no provider call', async () => {
    const governor = AICallGovernor.getInstance();
    // Exhaust the jev budget first with distinct symbols.
    const budget = aiCallGovernor.jevCallsPerMinute;
    for (let i = 0; i < budget; i++) {
      const symbol = tickerFor(i);
      kickOffJevShadowScoring({
        article: { ...BASE_ARTICLE, fingerprint: `skip-fp-${i}`, symbols: [symbol] },
        symbol,
        traceId: `trace-skip-${i}`,
        llmAnalysis: null,
        deterministic: BASE_CTX,
      });
    }
    // One more article: must be skipped by the budget gate, never throw.
    const extra = tickerFor(budget + 100);
    expect(() =>
      kickOffJevShadowScoring({
        article: { ...BASE_ARTICLE, fingerprint: 'skip-fp-extra', symbols: [extra] },
        symbol: extra,
        traceId: 'trace-skip-extra',
        llmAnalysis: null,
        deterministic: BASE_CTX,
      }),
    ).not.toThrow();

    const deadline = Date.now() + 20_000;
    while (settled < budget && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const diag = governor.getDiagnostics();
    expect(diag.called).toBe(budget);
    expect(diag.skips['PROVIDER_BUDGET']).toBe(1);
  }, 30_000);
});
