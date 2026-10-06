/**
 * ==========================================================
 * Module:
 * JevNewsTriage.ts
 *
 * Purpose:
 * Jev-powered news triage for Argus — Phase 1 (shadow) through Phase 3.
 * Builds the perfect-data input contract, defines the single batched question
 * set, scores articles via JevProvider, and maps answers back into Argus's own
 * validated shapes. Phase 1 uses only scoreArticleWithJev() + the shadow ledger;
 * nothing here influences any trading decision.
 *
 * Design constraints (from docs/design/JEV_NEWS_TRIAGE_INTEGRATION_DESIGN.md):
 * - One evaluate() per article, all questions batched — never one request per question.
 * - buildJevNewsState() fails closed: any missing/invalid required field returns
 *   null and no request is made. Stale articles are skipped, not scored.
 * - Jev output maps into the same AIAnalysisResult-compatible fields through the
 *   same AIOutputValidator clamps the LLM path uses.
 * - AI is enhancement only: this module never emits a recommendation, vote, or
 *   trading signal. See the "AI is enhancement, never a dependency" boundary.
 *
 * Flag: ARGUS_JEV_SHADOW_SCORING_ENABLED (default false). Phase 2/3 add their own
 * flags; this module never reads them.
 * ==========================================================
 */

import { JevProvider, JevQuestion, JevEvaluationResult } from '../ai/providers/JevProvider';
import { looksLikeListedTicker, clampScore, coerceEnum, TRADING_BIAS_VALUES } from '../ai/AIOutputValidator';
import { NormalizedArticle } from './NewsNormalizer';
import { recordShadowScore } from './JevShadowLedger';
import { AIAnalysisResult } from './NewsScoringEngine';

/** Deterministic context bundled into every state so one request sees everything. */
export interface JevNewsDeterministicContext {
  category: string;
  credibility: number; // 0..1
  isNewCluster: boolean;
  priorArticleCount: number;
  impactScore01: number; // 0..1 local-first impact
  timeHorizon: string;
}

/** The validated, complete state sent to Jev. Built only by buildJevNewsState(). */
export interface JevNewsState {
  headline: string;
  body: string;
  source: string;
  publishedAt: string;
  symbol: string;
  context: {
    category: string;
    credibility: number;
    isNewCluster: boolean;
    priorArticleCount: number;
    localImpactScore01: number;
    timeHorizon: string;
  };
}

/** Articles older than this are never scored — stale news spends zero requests. */
export const JEV_NEWS_MAX_AGE_HOURS = 24;
/** Jev's documented budget: ~32k tokens for state + longest question. Stay well under. */
const MAX_BODY_CHARS = 12000;

export function isJevShadowEnabled(): boolean {
  return process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED === 'true';
}

/**
 * Perfect-data input contract. Returns a complete, validated state, or null when
 * anything required is missing/invalid/stale — in which case the caller must NOT
 * make a request. Never returns a partial state.
 */
export function buildJevNewsState(
  article: NormalizedArticle,
  symbol: string,
  ctx: JevNewsDeterministicContext,
  nowMs: number = Date.now(),
): JevNewsState | null {
  const ticker = looksLikeListedTicker(symbol);
  if (!ticker) return null;

  const headline = (article.title || '').trim();
  const body = (article.content || '').trim();
  const source = (article.source || '').trim();
  if (!headline || !body || !source) return null;

  const publishedMs = Date.parse(article.publishedAt || '');
  if (!Number.isFinite(publishedMs)) return null;
  if (nowMs - publishedMs > JEV_NEWS_MAX_AGE_HOURS * 3600_1000) return null; // stale
  if (publishedMs > nowMs + 5 * 60_1000) return null; // future-dated feed garbage

  const credibility = Number(ctx.credibility);
  const impactScore01 = Number(ctx.impactScore01);
  if (!Number.isFinite(credibility) || credibility < 0 || credibility > 1) return null;
  if (!Number.isFinite(impactScore01) || impactScore01 < 0 || impactScore01 > 1) return null;

  // Truncate explicitly with a marker rather than silently — the scorer sees the full
  // headline and knows the body was cut.
  const truncatedBody = body.length > MAX_BODY_CHARS
    ? body.slice(0, MAX_BODY_CHARS) + '\n[BODY TRUNCATED FOR LENGTH]'
    : body;

  return {
    headline,
    body: truncatedBody,
    source,
    publishedAt: article.publishedAt,
    symbol: ticker,
    context: {
      category: String(ctx.category || 'General'),
      credibility,
      isNewCluster: ctx.isNewCluster === true,
      priorArticleCount: Math.max(0, Math.floor(Number(ctx.priorArticleCount) || 0)),
      localImpactScore01: impactScore01,
      timeHorizon: String(ctx.timeHorizon || 'unknown'),
    },
  };
}

/** The single batched question set — one evaluate() call answers all of these. */
export function buildJevNewsQuestions(state: JevNewsState): Record<string, JevQuestion> {
  const sym = state.symbol;
  return {
    is_relevant: {
      type: 'noul',
      instructions: `Is this news article relevant to trading decisions for ${sym}? Consider only direct relevance to the company's business, stock price, or sector.`,
    },
    sentiment: {
      type: 'choice',
      instructions: `What is the directional implication of this news for ${sym}'s stock price?`,
      criteria: {
        bullish: 'likely positive for the stock price',
        bearish: 'likely negative for the stock price',
        neutral: 'no clear directional implication for the stock price',
      },
    },
    market_impact: {
      type: 'score',
      instructions: `How significant is this news for ${sym}? Rate the likely market impact.`,
      criteria: [
        'negligible: routine news, unlikely to move the price',
        'minor: small developments, limited price relevance',
        'notable: meaningful news that could move the price modestly',
        'significant: important development likely to move the price clearly',
        'major: company-altering news, expect a strong price reaction',
      ],
    },
    is_surprise: {
      type: 'noul',
      instructions: `Is this news a genuine surprise relative to what the market likely already expected, rather than fully priced in or routine?`,
    },
    has_contradiction: {
      type: 'noul',
      instructions: `Does this article contain internally conflicting claims, or explicitly dispute or walk back an earlier report?`,
    },
    urgency: {
      type: 'score',
      instructions: `How time-sensitive is this news for a trading decision?`,
      criteria: [
        'stale or evergreen: no urgency at all',
        'low: relevant over days, not minutes',
        'moderate: worth acting on within the session',
        'high: fast-moving, minutes matter',
        'immediate: breaking, price may already be moving',
      ],
    },
  };
}

/** Jev's raw scored answers for one article, in Argus's own validated ranges. */
export interface JevNewsScore {
  relevantProb: number; // 0..1
  sentiment: 'bullish' | 'bearish' | 'neutral';
  sentimentConf: number; // 0..1
  sentimentProbs: Record<string, number>;
  impactScore: number; // 0..10
  impactConf: number; // 0..1
  surpriseProb: number; // 0..1
  contradictionProb: number; // 0..1
  urgencyScore: number; // 0..10
  urgencyConf: number; // 0..1
  minConfidence: number; // 0..1 — lowest confidence across all questions
  model: string;
  inputTokens: number;
  latencyMs: number;
}

function asNoul(answer: unknown): number {
  const a = answer as { type: string; noul: number };
  if (a?.type !== 'noul' || !Number.isFinite(a.noul)) throw new Error('bad noul answer');
  return Math.min(1, Math.max(0, a.noul));
}

function asChoice(answer: unknown): { choice: string; confidence: number; probabilities: Record<string, number> } {
  const a = answer as { type: string; choice: string; confidence: number; probabilities: Record<string, number> };
  if (a?.type !== 'choice' || typeof a.choice !== 'string') throw new Error('bad choice answer');
  return a;
}

function asScore(answer: unknown): { score: number; confidence: number } {
  const a = answer as { type: string; score: number; confidence: number };
  if (a?.type !== 'score' || !Number.isFinite(a.score)) throw new Error('bad score answer');
  return a;
}

/**
 * Score one article with Jev. One network request, all questions batched.
 * Throws on transport/validation failure — the caller (shadow ledger) records
 * the failure and moves on; scoring never blocks the news cycle.
 */
export async function scoreArticleWithJev(
  provider: JevProvider,
  state: JevNewsState,
  options?: { timeoutMs?: number },
): Promise<JevNewsScore> {
  const started = Date.now();
  const result: JevEvaluationResult = await provider.evaluate(
    state as unknown as Record<string, unknown>,
    buildJevNewsQuestions(state),
    { timeoutMs: options?.timeoutMs ?? 15000 },
  );
  const latencyMs = Date.now() - started;
  const a = result.answers;

  const sentimentRaw = asChoice(a.sentiment);
  const sentiment = (['bullish', 'bearish', 'neutral'] as const).includes(sentimentRaw.choice as any)
    ? (sentimentRaw.choice as 'bullish' | 'bearish' | 'neutral')
    : 'neutral';
  const impact = asScore(a.market_impact);
  const urgency = asScore(a.urgency);

  // Score questions use 0..N-1 level indexes; normalize to 0..10 for Argus's own scale.
  const normalizeScore = (v: number, levels: number) => (v / Math.max(1, levels - 1)) * 10;

  const confidences = [
    sentimentRaw.confidence,
    impact.confidence,
    urgency.confidence,
  ].filter((c) => Number.isFinite(c));
  const minConfidence = confidences.length > 0 ? Math.min(...confidences) : 0;

  return {
    relevantProb: asNoul(a.is_relevant),
    sentiment,
    sentimentConf: clampScore(sentimentRaw.confidence, 0, 1, 0),
    sentimentProbs: sentimentRaw.probabilities || {},
    impactScore: clampScore(normalizeScore(impact.score, 5), 0, 10, 0),
    impactConf: clampScore(impact.confidence, 0, 1, 0),
    surpriseProb: asNoul(a.is_surprise),
    contradictionProb: asNoul(a.has_contradiction),
    urgencyScore: clampScore(normalizeScore(urgency.score, 5), 0, 10, 0),
    urgencyConf: clampScore(urgency.confidence, 0, 1, 0),
    minConfidence: clampScore(minConfidence, 0, 1, 0),
    model: result.model,
    inputTokens: result.inputTokens,
    latencyMs,
  };
}

/**
 * Phase 1 shadow orchestrator. Fire-and-forget: returns immediately, never throws,
 * never blocks the news cycle, never influences any decision. Scores the article with
 * Jev in parallel and records the result (plus the LLM's own analysis when present)
 * to the agreement ledger.
 */
export interface ShadowScoringInput {
  article: NormalizedArticle;
  symbol: string;
  traceId: string;
  /** The LLM's analysis of this SAME article, or null when the LLM path didn't run. */
  llmAnalysis: AIAnalysisResult | null;
  deterministic: JevNewsDeterministicContext;
}

let cachedProvider: JevProvider | null | undefined;

function getShadowProvider(): JevProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;
  const apiKey = (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || '').trim();
  if (!apiKey) {
    cachedProvider = null;
    return null;
  }
  const provider = new JevProvider();
  // initialize() is async but only assigns fields; safe to call without awaiting here
  // because scoreArticleWithJev() awaits the network call that happens after.
  void provider.initialize(apiKey);
  cachedProvider = provider;
  return provider;
}

/** Test hook: reset the cached provider between tests. */
export function resetJevShadowProviderCache(): void {
  cachedProvider = undefined;
}

export function kickOffJevShadowScoring(input: ShadowScoringInput): void {
  if (!isJevShadowEnabled()) return;
  const provider = getShadowProvider();
  if (!provider) return; // no key configured — shadow scoring silently idle

  const state = buildJevNewsState(input.article, input.symbol, input.deterministic);
  if (!state) return; // fail-closed on imperfect data: no request

  void (async () => {
    try {
      const score = await scoreArticleWithJev(provider, state);
      await recordShadowScore({
        articleFingerprint: input.article.fingerprint,
        symbol: state.symbol,
        traceId: input.traceId,
        jevScore: score,
        llmAnalysis: input.llmAnalysis,
      });
    } catch (e) {
      // Shadow scoring must never break the news cycle. Log and move on.
      console.warn('[JevShadow] scoring failed (observation dropped):', (e as Error)?.message || e);
    }
  })();
}
/**
 * Map a Jev score into the LLM path's own field scales, for apples-to-apples
 * agreement measurement (Phase 1) and for the future escalated path (Phase 2).
 * Uses the same clamps as NewsScoringEngine's validation.
 */
export function mapJevScoreToAnalysisFields(score: JevNewsScore): {
  sentimentScore: number; // -1..1
  marketImpactScore: number; // 0..100
  confidence: number; // 0..100
  tradingBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  marketSurprise: number; // 0..1
  contradictoryEvidence: boolean;
} {
  const directional = score.sentiment === 'bullish' ? 1 : score.sentiment === 'bearish' ? -1 : 0;
  return {
    sentimentScore: clampScore(directional * score.sentimentConf, -1, 1, 0),
    marketImpactScore: clampScore(score.impactScore * 10, 0, 100, 0),
    confidence: clampScore(score.minConfidence * 100, 0, 100, 0),
    tradingBias: coerceEnum(
      score.sentiment === 'bullish' ? 'BULLISH' : score.sentiment === 'bearish' ? 'BEARISH' : 'NEUTRAL',
      TRADING_BIAS_VALUES,
      'NEUTRAL',
    ),
    marketSurprise: clampScore(score.surpriseProb, 0, 1, 0),
    contradictoryEvidence: score.contradictionProb >= 0.5,
  };
}
