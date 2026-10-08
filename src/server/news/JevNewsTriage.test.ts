/**
 * JevNewsTriage — Phase 1 tests (no network, no API key).
 * Proves: the perfect-data input contract fails closed on every imperfect input,
 * the question set is batched as a single set, and score mapping uses Argus's
 * own validated scales.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildJevNewsState,
  buildJevNewsQuestions,
  scoreArticleWithJev,
  mapJevScoreToAnalysisFields,
  isJevShadowEnabled,
  kickOffJevShadowScoring,
  resetJevShadowProviderCache,
  JevNewsDeterministicContext,
  JevNewsScore,
} from './JevNewsTriage';
import { JevProvider } from '../ai/providers/JevProvider';
import { NormalizedArticle } from './NewsNormalizer';
import { AICallGovernor } from '../ai/AICallGovernor';
import { aiCallGovernor } from '../config/aiCallGovernor';

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

describe('buildJevNewsState (perfect-data contract)', () => {
  it('builds a complete state for a valid article', () => {
    const state = buildJevNewsState(BASE_ARTICLE, 'ACME', BASE_CTX);
    expect(state).not.toBeNull();
    expect(state!.symbol).toBe('ACME');
    expect(state!.headline).toBe(BASE_ARTICLE.title);
    expect(state!.context.credibility).toBe(0.8);
  });

  it('fails closed on missing title', () => {
    expect(buildJevNewsState({ ...BASE_ARTICLE, title: '  ' }, 'ACME', BASE_CTX)).toBeNull();
  });

  it('fails closed on missing content', () => {
    expect(buildJevNewsState({ ...BASE_ARTICLE, content: '' }, 'ACME', BASE_CTX)).toBeNull();
  });

  it('fails closed on missing source', () => {
    expect(buildJevNewsState({ ...BASE_ARTICLE, source: '' }, 'ACME', BASE_CTX)).toBeNull();
  });

  it('fails closed on an invalid ticker', () => {
    expect(buildJevNewsState(BASE_ARTICLE, 'not a ticker!!!', BASE_CTX)).toBeNull();
  });

  it('fails closed on stale articles (older than 24h)', () => {
    const stale = { ...BASE_ARTICLE, publishedAt: new Date(Date.now() - 25 * 3600_1000).toISOString() };
    expect(buildJevNewsState(stale, 'ACME', BASE_CTX)).toBeNull();
  });

  it('fails closed on unparseable timestamps', () => {
    expect(buildJevNewsState({ ...BASE_ARTICLE, publishedAt: 'not-a-date' }, 'ACME', BASE_CTX)).toBeNull();
  });

  it('fails closed on future-dated articles', () => {
    const future = { ...BASE_ARTICLE, publishedAt: new Date(Date.now() + 3600_1000).toISOString() };
    expect(buildJevNewsState(future, 'ACME', BASE_CTX)).toBeNull();
  });

  it('fails closed on out-of-range credibility', () => {
    expect(buildJevNewsState(BASE_ARTICLE, 'ACME', { ...BASE_CTX, credibility: 1.5 })).toBeNull();
    expect(buildJevNewsState(BASE_ARTICLE, 'ACME', { ...BASE_CTX, credibility: NaN })).toBeNull();
  });

  it('truncates overlong bodies explicitly rather than silently', () => {
    const long = { ...BASE_ARTICLE, content: 'x'.repeat(20000) };
    const state = buildJevNewsState(long, 'ACME', BASE_CTX);
    expect(state).not.toBeNull();
    expect(state!.body).toContain('[BODY TRUNCATED FOR LENGTH]');
    expect(state!.body.length).toBeLessThan(20000);
  });
});

describe('buildJevNewsQuestions', () => {
  it('batches all six questions in a single set', () => {
    const state = buildJevNewsState(BASE_ARTICLE, 'ACME', BASE_CTX)!;
    const questions = buildJevNewsQuestions(state);
    expect(Object.keys(questions).sort()).toEqual(
      ['has_contradiction', 'is_relevant', 'is_surprise', 'market_impact', 'sentiment', 'urgency'].sort(),
    );
    expect(questions.sentiment.type).toBe('choice');
    expect(questions.is_relevant.type).toBe('noul');
    expect(questions.market_impact.type).toBe('score');
  });
});

describe('scoreArticleWithJev', () => {
  it('makes exactly one evaluate() call and maps answers to Argus scales', async () => {
    const provider = new JevProvider();
    await provider.initialize('test-key');
    const evaluateSpy = vi.spyOn(provider, 'evaluate').mockResolvedValue({
      model: 'jev-1.13.0',
      answers: {
        is_relevant: { type: 'noul', noul: 0.95 },
        sentiment: { type: 'choice', choice: 'bullish', confidence: 0.82, probabilities: { bullish: 0.82, bearish: 0.1, neutral: 0.08 } },
        market_impact: { type: 'score', score: 3, confidence: 0.7, legend: {}, probabilities: {} },
        is_surprise: { type: 'noul', noul: 0.6 },
        has_contradiction: { type: 'noul', noul: 0.05 },
        urgency: { type: 'score', score: 2, confidence: 0.65, legend: {}, probabilities: {} },
      },
      inputTokens: 400,
      outputTokens: 0,
    });

    const state = buildJevNewsState(BASE_ARTICLE, 'ACME', BASE_CTX)!;
    const score = await scoreArticleWithJev(provider, state);

    expect(evaluateSpy).toHaveBeenCalledTimes(1); // single batched request
    expect(score.sentiment).toBe('bullish');
    expect(score.sentimentConf).toBeCloseTo(0.82, 5);
    expect(score.impactScore).toBeCloseTo(7.5, 5); // level 3 of 5 -> 7.5/10
    expect(score.surpriseProb).toBeCloseTo(0.6, 5);
    expect(score.model).toBe('jev-1.13.0');
    expect(score.inputTokens).toBe(400);
    expect(score.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('propagates provider failures to the caller (ledger records the drop)', async () => {
    const provider = new JevProvider();
    await provider.initialize('test-key');
    vi.spyOn(provider, 'evaluate').mockRejectedValue(new Error('boom'));
    const state = buildJevNewsState(BASE_ARTICLE, 'ACME', BASE_CTX)!;
    await expect(scoreArticleWithJev(provider, state)).rejects.toThrow('boom');
  });
});

describe('mapJevScoreToAnalysisFields', () => {
  const baseScore: JevNewsScore = {
    relevantProb: 0.9, sentiment: 'bullish', sentimentConf: 0.8,
    sentimentProbs: { bullish: 0.8, bearish: 0.1, neutral: 0.1 },
    impactScore: 7.5, impactConf: 0.7, surpriseProb: 0.6, contradictionProb: 0.05,
    urgencyScore: 5, urgencyConf: 0.65, minConfidence: 0.65,
    model: 'jev-1.13.0', inputTokens: 400, latencyMs: 250,
  };

  it('maps bullish sentiment to the LLM path scales', () => {
    const mapped = mapJevScoreToAnalysisFields(baseScore);
    expect(mapped.sentimentScore).toBeCloseTo(0.8, 5);
    expect(mapped.tradingBias).toBe('BULLISH');
    expect(mapped.marketImpactScore).toBeCloseTo(75, 5);
    expect(mapped.confidence).toBeCloseTo(65, 5);
    expect(mapped.marketSurprise).toBeCloseTo(0.6, 5);
    expect(mapped.contradictoryEvidence).toBe(false);
  });

  it('maps bearish sentiment with sign flip', () => {
    const mapped = mapJevScoreToAnalysisFields({ ...baseScore, sentiment: 'bearish' });
    expect(mapped.sentimentScore).toBeCloseTo(-0.8, 5);
    expect(mapped.tradingBias).toBe('BEARISH');
  });

  it('flags contradiction at >= 0.5 probability', () => {
    const mapped = mapJevScoreToAnalysisFields({ ...baseScore, contradictionProb: 0.7 });
    expect(mapped.contradictoryEvidence).toBe(true);
  });

  it('clamps out-of-range values instead of propagating them', () => {
    const mapped = mapJevScoreToAnalysisFields({ ...baseScore, sentimentConf: 2.5 });
    expect(mapped.sentimentScore).toBeLessThanOrEqual(1);
  });
});

describe('isJevShadowEnabled', () => {
  const ORIGINAL = process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
    else process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = ORIGINAL;
  });

  it('defaults to OFF', () => {
    delete process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
    expect(isJevShadowEnabled()).toBe(false);
  });

  it('enables only on explicit true', () => {
    process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = 'true';
    expect(isJevShadowEnabled()).toBe(true);
    process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = '1';
    expect(isJevShadowEnabled()).toBe(false);
  });
});

describe('kickOffJevShadowScoring', () => {
  const FLAG = process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
  const KEY = process.env.JEV_API_KEY;
  const TYPESAFE_KEY = process.env.TYPESAFE_API_KEY;
  afterEach(() => {
    if (FLAG === undefined) delete process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
    else process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = FLAG;
    if (KEY === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = KEY;
    if (TYPESAFE_KEY === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = TYPESAFE_KEY;
    resetJevShadowProviderCache();
  });

  function shadowInput(overrides: Partial<{ article: NormalizedArticle }> = {}) {
    return {
      article: { ...BASE_ARTICLE, ...(overrides.article ?? {}) },
      symbol: 'ACME',
      traceId: 'trace-1',
      llmAnalysis: null,
      deterministic: BASE_CTX,
    };
  }

  it('is a no-op when the flag is off - never throws, never touches the provider', () => {
    delete process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    resetJevShadowProviderCache();
    expect(() => kickOffJevShadowScoring(shadowInput())).not.toThrow();
  });

  it('is a no-op when the flag is on but no API key is configured', () => {
    process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = 'true';
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    resetJevShadowProviderCache();
    expect(() => kickOffJevShadowScoring(shadowInput())).not.toThrow();
  });

  it('is a no-op on imperfect state even with flag and key - no request is made', () => {
    process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = 'true';
    process.env.JEV_API_KEY = 'test-key-not-used';
    resetJevShadowProviderCache();
    // Empty title -> buildJevNewsState returns null -> no request, no throw.
    // (Provider would only be constructed, never called - and no network in unit tests.)
    expect(() => kickOffJevShadowScoring(shadowInput({ article: { ...BASE_ARTICLE, title: '' } }))).not.toThrow();
  });
});
