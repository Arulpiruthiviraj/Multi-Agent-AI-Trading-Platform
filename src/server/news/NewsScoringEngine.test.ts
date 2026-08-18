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

    const result = await engine.analyzeWithAI(article(), 't1');

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

    const result = await engine.analyzeWithAI(article(), 't2');

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

    const result = await engine.analyzeWithAI(article(), 't3');

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

    const result = await engine.analyzeWithAI(article({ title: 'Real Title', source: 'RealSource' }), 't4');

    expect(result!.headline).toBe('Real Title');
    expect(result!.source).toBe('RealSource');
  });

  it('returns null (not a fabricated result) when the AI response is not valid JSON at all', async () => {
    routeTask.mockResolvedValue({ content: 'not json at all', aiCallId: 'c5', provider: 'gemini', latency: 50 });

    const result = await engine.analyzeWithAI(article(), 't5');

    expect(result).toBeNull();
  });

  it('buildLocalFirstNewsAnalysis maps FinBERT signed score without inventing an LLM result', async () => {
    const { buildLocalFirstNewsAnalysis } = await import('./NewsScoringEngine');
    const result = buildLocalFirstNewsAnalysis(article(), {
      symbol: 'NVDA',
      category: 'Earnings',
      sentiment: 0.8,
      impactScore01: 0.9,
      reasoning: '[Local-First] Remote LLM failed; using finbert sentiment 0.80.',
    });
    expect(result.tradingBias).toBe('BULLISH');
    expect(result.sentimentScore).toBe(0.8);
    expect(result._provider).toBeUndefined();
    expect(result.reasoning).toContain('finbert');
  });
});
