import { AIRouter } from '../ai/AIRouter';
import { NormalizedArticle } from './NewsNormalizer';
import { coerceEnum, clampScore, coerceString, coerceStringArray, TRADING_BIAS_VALUES, looksLikeListedTicker } from '../ai/AIOutputValidator';

export interface AIAnalysisResult {
  symbol: string;
  headline: string;
  source: string;
  timestamp: string;
  category: string;
  sentimentScore: number;
  marketImpactScore: number;
  confidence: number;
  affectedSectors: string[];
  tradingBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  reasoning: string;
  riskFlags: string[];
  // Internal telemetry (not part of the AI's own structured output schema) - present only when
  // this result came from a real AI call, absent for NewsEngine's local-first FinBERT path.
  _aiCallId?: string;
  _provider?: string;
  _latencyMs?: number;
}

export class NewsScoringEngine {
  public async analyzeWithAI(article: NormalizedArticle, traceId: string): Promise<AIAnalysisResult | null> {
    const prompt = `Analyze this news article for its impact on financial markets.
Title: ${article.title}
Content: ${article.content}
Source: ${article.source}
Return a strict JSON object matching exactly this schema, with no markdown formatting:
{
  "symbol": "Primary affected ticker (e.g., NVDA)",
  "headline": "...",
  "source": "...",
  "timestamp": "...",
  "category": "...",
  "sentimentScore": 0.8,
  "marketImpactScore": 85,
  "confidence": 90,
  "affectedSectors": ["Technology", "Semiconductors"],
  "tradingBias": "BULLISH",
  "reasoning": "...",
  "riskFlags": ["High Volatility"]
}`;

    try {
      const res = await AIRouter.getInstance().routeTask('NewsAgent', prompt, traceId, true);
      let text = res.content;
      
      // Strip markdown code block if present
      if (text.startsWith('```json')) {
        text = text.replace(/^```json\n/, '').replace(/\n```$/, '');
      } else if (text.startsWith('```')) {
        text = text.replace(/^```\n/, '').replace(/\n```$/, '');
      }
      
      const raw = JSON.parse(text);
      // Hardening pass, Phase 5: this was previously a raw type cast (`as AIAnalysisResult`),
      // not a runtime check - NewsEngine.ts's `tradingBias === 'BULLISH' ? 'BUY' : 'SELL'` means
      // any off-schema tradingBias value would previously resolve to SELL regardless of the
      // model's real sentiment. Validated once here, at the source, so every consumer of this
      // result (NewsEngine.ts, and anything reading news_articles later) gets a real,
      // schema-conformant value - ranges match this file's own prompt/schema: sentimentScore
      // -1..1 (matching NewsImpactEngine's real FinBERT scale, which populates the same field on
      // the local-first path), marketImpactScore/confidence 0..100 (matching this prompt's own
      // example values and NewsEngine.ts's `confidence / 100` usage).
      const validated: AIAnalysisResult = {
        symbol: looksLikeListedTicker(raw.symbol) ?? 'UNKNOWN',
        headline: coerceString(raw.headline, article.title),
        source: coerceString(raw.source, article.source),
        timestamp: coerceString(raw.timestamp, article.publishedAt),
        category: coerceString(raw.category, 'General'),
        sentimentScore: clampScore(raw.sentimentScore, -1, 1, 0),
        marketImpactScore: clampScore(raw.marketImpactScore, 0, 100, 0),
        confidence: clampScore(raw.confidence, 0, 100, 0),
        affectedSectors: coerceStringArray(raw.affectedSectors),
        tradingBias: coerceEnum(raw.tradingBias, TRADING_BIAS_VALUES, 'NEUTRAL'),
        reasoning: coerceString(raw.reasoning, 'No reasoning provided.'),
        riskFlags: coerceStringArray(raw.riskFlags),
        _aiCallId: res.aiCallId,
        _provider: res.provider,
        _latencyMs: res.latency,
      };
      return validated;
    } catch (e) {
      console.error('[NewsScoringEngine] AI Analysis failed:', e);
      return null;
    }
  }
}
