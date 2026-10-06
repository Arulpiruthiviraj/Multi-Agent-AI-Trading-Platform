/**
 * ==========================================================
 * Module:
 * JevNewsTypes.ts
 *
 * Purpose:
 * Shared types and pure mappings for Jev news scoring. Extracted from
 * JevNewsTriage.ts to break the JevNewsTriage <-> JevShadowLedger circular
 * module dependency: both modules (and JevEscalation) import from here;
 * nothing here imports from either of them.
 * ==========================================================
 */

import { clampScore, coerceEnum, TRADING_BIAS_VALUES } from '../ai/AIOutputValidator';

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

/**
 * Map a Jev score into the LLM path's own field scales, for apples-to-apples
 * agreement measurement (Phase 1) and for the escalated path (Phase 2).
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
