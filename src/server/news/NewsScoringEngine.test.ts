import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedArticle } from './NewsNormalizer';

// Real test coverage for the Phase 5 hardening fix: analyzeWithAI() previously did
// `JSON.parse(text) as AIAnalysisResult` - a compile-time-only cast, no runtime check. The real
// consequence lived in NewsEngine.ts's `tradingBias === 'BULLISH' ? 'BUY' : 'SELL'`: any
// off-schema tradingBias silently became SELL regardless of the model's real sentiment.
const { routeTask } = vi.hoisted(() => ({ routeTask: vi.fn() }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeTask }) } }));

import { NewsScoringEngine } from './NewsScoringEngine';

function article(overrides: Partial<NormalizedArticle> = {}): NormalizedArticle {
  return {
    id: 'a1', title: 'Nvidia beats earnings', content: 'Full article text here.',
    url: 'https://example.com/a1', source: 'TestWire', author: 'Test Author',
    publishedAt: '2026-01-15T12:00:00.000Z', symbols: ['NVDA'], fingerprint: 'fp1',
    ...overrides,
  };
}

const DETERMINISTIC = {
  category: 'Earnings',
  impactScore01: 0.9,
  timeHorizon: 'Intraday',
  isNewCluster: true,
  priorArticleCount: 0,
  credibility: 0.9,
};

describe('NewsScoringEngine.analyzeWithAI - AI output validation (Phase 5 hardening)', () => {
  let engine: NewsScoringEngine;

  beforeEach(() => {
    routeTask.mockClear();
    engine = new NewsScoringEngine();
  });

  it('the exact bug being fixed: an off-schema tradingBias no longer silently resolves toward SELL - it becomes NEUTRAL', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({ tradingBias: 'POSITIVE', sentimentScore: 0.9, confidence: 90, reasoning: 'strong beat' }),
      aiCallId: 'c1', provider: 'gemini', latency: 50,
    });

    const result = await engine.analyzeWithAI(article(), 't1', DETERMINISTIC);

    // Under the old raw cast, NewsEngine.ts's ternary would have treated 'POSITIVE' as not
    // literally 'BULLISH' and mapped it to SELL - the opposite of what "strong beat"/0.9 sentiment
    // actually means. Validated, it correctly falls back to NEUTRAL (no trade idea emitted for it).
    expect(result!.tradingBias).toBe('NEUTRAL');
  });

  it('clamps an out-of-range sentimentScore/marketImpactScore/confidence into their real documented ranges', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({ tradingBias: 'BULLISH', sentimentScore: 5.5, marketImpactScore: 250, confidence: -30, reasoning: 'test' }),
      aiCallId: 'c2', provider: 'gemini', latency: 50,
    });

    const result = await engine.analyzeWithAI(article(), 't2', DETERMINISTIC);

    expect(result!.sentimentScore).toBe(1); // clamped into [-1, 1]
    expect(result!.marketImpactScore).toBe(100); // clamped into [0, 100]
    expect(result!.confidence).toBe(0); // clamped into [0, 100]
  });

  it('passes through a well-formed response unchanged', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({
        symbol: 'NVDA', headline: 'Nvidia beats earnings', source: 'TestWire', timestamp: '2026-01-15T12:00:00.000Z',
        category: 'Earnings', sentimentScore: 0.8, marketImpactScore: 85, confidence: 90,
        affectedSectors: ['Technology', 'Semiconductors'], tradingBias: 'BULLISH',
        reasoning: 'Strong earnings beat with raised guidance.', riskFlags: ['High Volatility'],
      }),
      aiCallId: 'c3', provider: 'gemini', latency: 50,
    });

    const result = await engine.analyzeWithAI(article(), 't3', DETERMINISTIC);

    expect(result).toMatchObject({
      symbol: 'NVDA', tradingBias: 'BULLISH', sentimentScore: 0.8, marketImpactScore: 85, confidence: 90,
      affectedSectors: ['Technology', 'Semiconductors'], riskFlags: ['High Volatility'],
    });
    expect(result!._aiCallId).toBe('c3');
  });

  it('falls back to the article\'s own real fields when the AI omits symbol/headline/source', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({ tradingBias: 'NEUTRAL', confidence: 50 }),
      aiCallId: 'c4', provider: 'gemini', latency: 50,
    });

    const result = await engine.analyzeWithAI(article({ title: 'Real Title', source: 'RealSource' }), 't4', DETERMINISTIC);

    expect(result!.headline).toBe('Real Title');
    expect(result!.source).toBe('RealSource');
  });

  it('returns null (not a fabricated result) when the AI response is not valid JSON at all', async () => {
    routeTask.mockResolvedValue({ content: 'not json at all', aiCallId: 'c5', provider: 'gemini', latency: 50 });

    const result = await engine.analyzeWithAI(article(), 't5', DETERMINISTIC);

    expect(result).toBeNull();
  });

  it('Phase F3: materiality/novelty/expectedHorizon/catalystType are always deterministic, never taken from the LLM raw response', async () => {
    routeTask.mockResolvedValue({
      // Even if the model somehow included these fields, they must be ignored - only
      // marketSurprise/contradictoryEvidence are genuinely asked of the LLM.
      content: JSON.stringify({ tradingBias: 'BULLISH', confidence: 90, materiality: 'LOW', novelty: 0 }),
      aiCallId: 'c6', provider: 'gemini', latency: 50,
    });

    const result = await engine.analyzeWithAI(article(), 't6', {
      category: 'Earnings', impactScore01: 0.9, timeHorizon: 'Intraday', isNewCluster: true, priorArticleCount: 0,
      credibility: 0.9,
    });

    expect(result!.materiality).toBe('CRITICAL'); // derived from impactScore01=0.9, not the LLM's 'LOW'
    expect(result!.novelty).toBe(1); // derived from isNewCluster=true, not the LLM's 0
    expect(result!.expectedHorizon).toBe('INTRADAY');
    expect(result!.catalystType).toBe('EARNINGS');
  });

  it('Phase F3: marketSurprise/contradictoryEvidence are genuinely read from the LLM, schema-validated', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({ tradingBias: 'BULLISH', confidence: 90, marketSurprise: 0.75, contradictoryEvidence: true }),
      aiCallId: 'c7', provider: 'gemini', latency: 50,
    });

    const result = await engine.analyzeWithAI(article(), 't7', DETERMINISTIC);

    expect(result!.marketSurprise).toBe(0.75);
    expect(result!.contradictoryEvidence).toBe(true);
  });

  it('Phase F3: marketSurprise is clamped into [0,1] and contradictoryEvidence falls back to false on garbage input', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({ tradingBias: 'NEUTRAL', confidence: 50, marketSurprise: 5, contradictoryEvidence: 'yes' }),
      aiCallId: 'c8', provider: 'gemini', latency: 50,
    });

    const result = await engine.analyzeWithAI(article(), 't8', DETERMINISTIC);

    expect(result!.marketSurprise).toBe(1);
    expect(result!.contradictoryEvidence).toBe(false);
  });

  it('Phase F4: riskLevel/riskVeto reflect contradictoryEvidence from the LLM, not tradingBias - a bullish call can still be high-risk', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({ tradingBias: 'BULLISH', confidence: 90, contradictoryEvidence: true }),
      aiCallId: 'c9', provider: 'gemini', latency: 50,
    });

    const result = await engine.analyzeWithAI(article(), 't9', { ...DETERMINISTIC, credibility: 0.5 });

    expect(result!.tradingBias).toBe('BULLISH');
    expect(result!.riskVeto).toBe(true);
    expect(result!.riskVetoReason).toContain('Contradictory evidence');
  });

  it('Phase F4: riskLevel/riskVeto are low-risk for a credible, non-contradictory report', async () => {
    routeTask.mockResolvedValue({
      content: JSON.stringify({ tradingBias: 'BEARISH', confidence: 90, contradictoryEvidence: false }),
      aiCallId: 'c10', provider: 'gemini', latency: 50,
    });

    const result = await engine.analyzeWithAI(article(), 't10', { ...DETERMINISTIC, credibility: 0.95, priorArticleCount: 5, isNewCluster: false });

    expect(result!.riskLevel).toBe('LOW');
    expect(result!.riskVeto).toBe(false);
    expect(result!.riskVetoReason).toBeNull();
  });

  it('buildLocalFirstNewsAnalysis maps FinBERT signed score without inventing an LLM result', async () => {
    const { buildLocalFirstNewsAnalysis } = await import('./NewsScoringEngine');
    const result = buildLocalFirstNewsAnalysis(article(), {
      symbol: 'NVDA',
      category: 'Earnings',
      sentiment: 0.8,
      impactScore01: 0.9,
      timeHorizon: 'Intraday',
      isNewCluster: true,
      priorArticleCount: 0,
      credibility: 0.9,
      reasoning: '[Local-First] Remote LLM failed; using finbert sentiment 0.80.',
    });
    expect(result.tradingBias).toBe('BULLISH');
    expect(result.sentimentScore).toBe(0.8);
    expect(result._provider).toBeUndefined();
    expect(result.reasoning).toContain('finbert');
  });

  it('Phase F3: buildLocalFirstNewsAnalysis populates materiality/novelty/horizon/catalystType deterministically, with an honest false contradictoryEvidence default', async () => {
    const { buildLocalFirstNewsAnalysis } = await import('./NewsScoringEngine');
    const brandNew = buildLocalFirstNewsAnalysis(article(), {
      symbol: 'NVDA', category: 'Earnings', sentiment: 0.8, impactScore01: 0.9,
      timeHorizon: 'Intraday', isNewCluster: true, priorArticleCount: 0, credibility: 0.9,
      reasoning: 'test',
    });
    expect(brandNew.materiality).toBe('CRITICAL');
    expect(brandNew.novelty).toBe(1);
    expect(brandNew.expectedHorizon).toBe('INTRADAY');
    expect(brandNew.catalystType).toBe('EARNINGS');
    expect(brandNew.contradictoryEvidence).toBe(false);

    const corroborating = buildLocalFirstNewsAnalysis(article(), {
      symbol: 'NVDA', category: 'Earnings', sentiment: 0.8, impactScore01: 0.9,
      timeHorizon: 'Intraday', isNewCluster: false, priorArticleCount: 4, credibility: 0.9,
      reasoning: 'test',
    });
    expect(corroborating.novelty).toBeLessThan(brandNew.novelty);
  });
});
