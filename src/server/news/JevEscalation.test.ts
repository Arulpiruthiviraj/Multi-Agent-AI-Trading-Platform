/**
 * JevEscalation — Phase 2 tests. The decision function is pure; thresholds come
 * from config/tradingSafety.json (conservative initials, pending calibration).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { decideJevEscalation, isJevEscalationEnabled, buildJevAnalysisResult } from './JevEscalation';
import { JevNewsScore } from './JevNewsTriage';
import { NormalizedArticle } from './NewsNormalizer';

const CONFIDENT_SCORE: JevNewsScore = {
  relevantProb: 0.9, sentiment: 'bullish', sentimentConf: 0.85,
  sentimentProbs: { bullish: 0.85, bearish: 0.1, neutral: 0.05 },
  impactScore: 5.0, impactConf: 0.8, surpriseProb: 0.5, contradictionProb: 0.05,
  urgencyScore: 4, urgencyConf: 0.7, minConfidence: 0.8,
  model: 'jev-1.13.0', inputTokens: 400, latencyMs: 250,
};

const ARTICLE: NormalizedArticle = {
  id: 'a1', title: 'T', content: 'C', url: 'u', source: 'S', author: 'A',
  publishedAt: new Date().toISOString(), symbols: ['ACME'], fingerprint: 'fp',
};

describe('decideJevEscalation', () => {
  it('escalates when Jev is unavailable — existing path preserved', () => {
    const d = decideJevEscalation({ jevScore: null, credibility: 0.5 });
    expect(d.escalateToLlm).toBe(true);
    expect(d.reason).toContain('unavailable');
  });

  it('accepts a confident Jev score — LLM skipped', () => {
    const d = decideJevEscalation({ jevScore: CONFIDENT_SCORE, credibility: 0.5 });
    expect(d.escalateToLlm).toBe(false);
    expect(d.reason).toContain('confident');
  });

  it('escalates on low Jev confidence', () => {
    const d = decideJevEscalation({
      jevScore: { ...CONFIDENT_SCORE, minConfidence: 0.3 },
      credibility: 0.5,
    });
    expect(d.escalateToLlm).toBe(true);
    expect(d.reason).toContain('below threshold');
  });

  it('escalates on low relevance even when confident', () => {
    const d = decideJevEscalation({
      jevScore: { ...CONFIDENT_SCORE, relevantProb: 0.2 },
      credibility: 0.5,
    });
    expect(d.escalateToLlm).toBe(true);
  });

  it('escalates high-stakes articles despite high Jev confidence', () => {
    const d = decideJevEscalation({
      jevScore: { ...CONFIDENT_SCORE, impactScore: 9.0 },
      credibility: 0.9,
    });
    expect(d.escalateToLlm).toBe(true);
    expect(d.reason).toContain('high-stakes');
  });

  it('does not treat merely credible OR merely impactful as high-stakes', () => {
    // high credibility but low impact -> not high-stakes, confident Jev accepted
    const d = decideJevEscalation({
      jevScore: { ...CONFIDENT_SCORE, impactScore: 3.0 },
      credibility: 0.95,
    });
    expect(d.escalateToLlm).toBe(false);
  });

  it('never throws on degenerate input', () => {
    expect(() => decideJevEscalation({ jevScore: null, credibility: NaN })).not.toThrow();
  });
});

describe('buildJevAnalysisResult', () => {
  it('builds a complete AIAnalysisResult honestly sourced from Jev', () => {
    const result = buildJevAnalysisResult(ARTICLE, CONFIDENT_SCORE, {
      symbol: 'ACME', category: 'Earnings', impactScore01: 0.7,
      timeHorizon: 'short', isNewCluster: true, priorArticleCount: 0, credibility: 0.8,
    });
    expect(result.symbol).toBe('ACME');
    expect(result.tradingBias).toBe('BULLISH');
    expect(result.sentimentScore).toBeCloseTo(0.85, 5);
    expect(result.reasoning).toContain('[Jev]');
    expect(result.reasoning).toContain('jev-1.13.0');
    expect(result.headline).toBe('T');
    expect(result.source).toBe('S');
  });

  it('maps an invalid ticker to UNKNOWN - never emits an unvalidated symbol', () => {
    const result = buildJevAnalysisResult(ARTICLE, CONFIDENT_SCORE, {
      symbol: 'not a ticker!!!', category: 'Earnings', impactScore01: 0.7,
      timeHorizon: 'short', isNewCluster: true, priorArticleCount: 0, credibility: 0.8,
    });
    expect(result.symbol).toBe('UNKNOWN');
  });

  it('maps bearish sentiment to BEARISH bias with negative sentiment score', () => {
    const bearish = { ...CONFIDENT_SCORE, sentiment: 'bearish' as const, sentimentConf: 0.7 };
    const result = buildJevAnalysisResult(ARTICLE, bearish, {
      symbol: 'ACME', category: 'Earnings', impactScore01: 0.7,
      timeHorizon: 'short', isNewCluster: true, priorArticleCount: 0, credibility: 0.8,
    });
    expect(result.tradingBias).toBe('BEARISH');
    expect(result.sentimentScore).toBeCloseTo(-0.7, 5);
  });
});

describe('isJevEscalationEnabled', () => {
  const ORIGINAL = process.env.ARGUS_JEV_ESCALATION_ENABLED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ARGUS_JEV_ESCALATION_ENABLED;
    else process.env.ARGUS_JEV_ESCALATION_ENABLED = ORIGINAL;
  });

  it('defaults to OFF', () => {
    delete process.env.ARGUS_JEV_ESCALATION_ENABLED;
    expect(isJevEscalationEnabled()).toBe(false);
  });

  it('enables only on explicit true', () => {
    process.env.ARGUS_JEV_ESCALATION_ENABLED = 'true';
    expect(isJevEscalationEnabled()).toBe(true);
  });
});
