import { AIRouter } from '../ai/AIRouter';
import { NormalizedArticle } from './NewsNormalizer';
import { coerceEnum, clampScore, coerceString, coerceStringArray, TRADING_BIAS_VALUES, looksLikeListedTicker } from '../ai/AIOutputValidator';
import { tradingSafety } from '../config/tradingSafety';
import {
  deriveMateriality, mapCategoryToCatalystType, mapTimeHorizonToExpectedHorizon,
  deriveNovelty, deriveLocalMarketSurpriseProxy, deriveRiskAssessment,
  type Materiality, type ExpectedHorizon, type CatalystType,
} from './NewsIntelligence';

const EXPECTED_HORIZON_VALUES: ExpectedHorizon[] = ['INTRADAY', 'SHORT_TERM', 'MEDIUM_TERM', 'LONGER_TERM', 'UNKNOWN'];

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
  // Phase F3 structured intelligence dimensions. materiality/novelty/expectedHorizon/catalystType
  // are ALWAYS deterministically derived from real upstream signals (impactScore, clustering
  // state, category/timeHorizon) - never asked of the LLM, which has no way to know e.g. how many
  // other articles already cover this same event. marketSurprise/contradictoryEvidence are the
  // two dimensions genuine LLM reasoning can add value on when escalated; buildLocalFirstNewsAnalysis
  // falls back to a documented heuristic proxy / false respectively.
  materiality: Materiality;
  novelty: number;
  marketSurprise: number;
  expectedHorizon: ExpectedHorizon;
  catalystType: CatalystType;
  contradictoryEvidence: boolean;
  // Phase F4: risk assessment, conceptually separate from tradingBias - see NewsIntelligence.ts's
  // deriveRiskAssessment doc comment. Always deterministic (credibility + contradictoryEvidence +
  // novelty), never LLM-guessed.
  riskLevel: Materiality;
  riskScore: number;
  riskVeto: boolean;
  riskVetoReason: string | null;
  // Internal telemetry (not part of the AI's own structured output schema) - present only when
  // this result came from a real AI call, absent for NewsEngine's local-first FinBERT path.
  _aiCallId?: string;
  _provider?: string;
  _latencyMs?: number;
}

export function buildLocalFirstNewsAnalysis(
  article: NormalizedArticle,
  opts: {
    symbol: string;
    category: string;
    sentiment: number;
    impactScore01: number;
    reasoning: string;
    timeHorizon: string;
    isNewCluster: boolean;
    priorArticleCount: number;
    credibility: number;
  },
): AIAnalysisResult {
  const localConfidencePct = Math.round(Math.min(85, 50 + Math.abs(opts.sentiment) * 40));
  const novelty = deriveNovelty(opts.isNewCluster, opts.priorArticleCount);
  const contradictoryEvidence = false;
  const risk = deriveRiskAssessment(opts.credibility, contradictoryEvidence, novelty, tradingSafety.newsRiskVetoThreshold);
  return {
    symbol: looksLikeListedTicker(opts.symbol) ?? 'UNKNOWN',
    headline: article.title,
    source: article.source,
    timestamp: article.publishedAt,
    category: opts.category,
    sentimentScore: opts.sentiment,
    marketImpactScore: opts.impactScore01 * 100,
    confidence: localConfidencePct,
    affectedSectors: [],
    tradingBias: opts.sentiment > 0 ? 'BULLISH' : opts.sentiment < 0 ? 'BEARISH' : 'NEUTRAL',
    reasoning: opts.reasoning,
    riskFlags: [],
    materiality: deriveMateriality(opts.impactScore01),
    novelty,
    marketSurprise: deriveLocalMarketSurpriseProxy(novelty, Math.abs(opts.sentiment)),
    expectedHorizon: mapTimeHorizonToExpectedHorizon(opts.timeHorizon),
    catalystType: mapCategoryToCatalystType(opts.category),
    // No cross-article contradiction signal is computed in this pass (would need sentiment
    // variance across the cluster's articles) - false is the honest default, not a guess.
    contradictoryEvidence,
    riskLevel: risk.riskLevel,
    riskScore: risk.riskScore,
    riskVeto: risk.riskVeto,
    riskVetoReason: risk.riskVetoReason,
  };
}

function coerceBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

export class NewsScoringEngine {
  public async analyzeWithAI(
    article: NormalizedArticle,
    traceId: string,
    deterministic: {
      category: string;
      impactScore01: number;
      timeHorizon: string;
      isNewCluster: boolean;
      priorArticleCount: number;
      credibility: number;
    },
  ): Promise<AIAnalysisResult | null> {
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
  "riskFlags": ["High Volatility"],
  "marketSurprise": 0.7,
  "contradictoryEvidence": false
}
marketSurprise (0-1): how different this is from what the market likely already expected - 0 means
fully priced in / expected, 1 means a genuine surprise. contradictoryEvidence: true only if the
article itself contains conflicting claims or explicitly disputes an earlier report.`;

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
      const contradictoryEvidence = coerceBoolean(raw.contradictoryEvidence, false);
      const novelty = deriveNovelty(deterministic.isNewCluster, deterministic.priorArticleCount);
      const risk = deriveRiskAssessment(deterministic.credibility, contradictoryEvidence, novelty, tradingSafety.newsRiskVetoThreshold);
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
        // Deterministic - never taken from the LLM's own guess (see AIAnalysisResult's comment).
        materiality: deriveMateriality(deterministic.impactScore01),
        novelty,
        expectedHorizon: mapTimeHorizonToExpectedHorizon(deterministic.timeHorizon),
        catalystType: mapCategoryToCatalystType(deterministic.category),
        // Genuine LLM reasoning, schema-validated like every other field in this object.
        marketSurprise: clampScore(raw.marketSurprise, 0, 1, 0),
        contradictoryEvidence,
        riskLevel: risk.riskLevel,
        riskScore: risk.riskScore,
        riskVeto: risk.riskVeto,
        riskVetoReason: risk.riskVetoReason,
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
