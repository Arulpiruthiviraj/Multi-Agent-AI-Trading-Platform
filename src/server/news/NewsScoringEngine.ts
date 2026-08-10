import { AIRouter } from '../ai/AIRouter';
import { NormalizedArticle } from './NewsNormalizer';

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
      
      const parsed = JSON.parse(text) as AIAnalysisResult;
      parsed._aiCallId = res.aiCallId;
      parsed._provider = res.provider;
      parsed._latencyMs = res.latency;
      return parsed;
    } catch (e) {
      console.error('[NewsScoringEngine] AI Analysis failed:', e);
      return null;
    }
  }
}
