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
      const res = await AIRouter.getInstance().routeTask('NewsAgent', prompt, traceId);
      let text = res.content;
      
      // Strip markdown code block if present
      if (text.startsWith('```json')) {
        text = text.replace(/^```json\n/, '').replace(/\n```$/, '');
      } else if (text.startsWith('```')) {
        text = text.replace(/^```\n/, '').replace(/\n```$/, '');
      }
      
      return JSON.parse(text) as AIAnalysisResult;
    } catch (e) {
      console.error('[NewsScoringEngine] AI Analysis failed:', e);
      return null;
    }
  }
}
