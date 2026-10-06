/**
 * ==========================================================
 * Module:
 * JevEscalation.ts
 *
 * Purpose:
 * Phase 2 confidence-gated escalation: Jev scores first (cheap, fast); the LLM
 * is called only when Jev's confidence is low, Jev is unavailable, or the
 * article is high-stakes. Pure decision logic here — the NewsEngine owns the
 * actual LLM call, same separation as EscalationPolicy.
 *
 * Flag: ARGUS_JEV_ESCALATION_ENABLED (default false). When off, NewsEngine runs
 * its existing FinBERT→LLM path byte-for-byte unchanged.
 *
 * Thresholds live in config/tradingSafety.json (never hardcoded here):
 * - jevEscalationConfidenceThreshold: accept Jev's score at/above this
 * - jevEscalationRelevanceThreshold:  article must clear this P(relevant) too
 * - jevHighStakesCredibility / jevHighStakesImpact: high-stakes definition
 * These are conservative initial values, explicitly pending calibration from
 * the Phase 1 agreement ledger — not measured optima.
 *
 * AI-independence: Jev unavailable/failed/timed-out → escalate to the existing
 * path, exactly as if Jev never existed. This module can never block news
 * analysis.
 * ==========================================================
 */

import { tradingSafety } from '../config/tradingSafety';
import { JevNewsScore, mapJevScoreToAnalysisFields } from './JevNewsTypes';
import { AIAnalysisResult } from './NewsScoringEngine';
import { NormalizedArticle } from './NewsNormalizer';
import {
  deriveMateriality,
  deriveNovelty,
  mapCategoryToCatalystType,
  mapTimeHorizonToExpectedHorizon,
  deriveRiskAssessment,
} from './NewsIntelligence';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';

export function isJevEscalationEnabled(): boolean {
  return process.env.ARGUS_JEV_ESCALATION_ENABLED === 'true';
}

export interface JevEscalationInput {
  /** Null when Jev was unavailable, failed, timed out, or the state was imperfect. */
  jevScore: JevNewsScore | null;
  credibility: number; // 0..1 deterministic source credibility
}

export interface JevEscalationDecision {
  /** True → run the existing LLM path. False → accept Jev's score, skip the LLM. */
  escalateToLlm: boolean;
  reason: string;
}

/**
 * Pure, independently testable. Mirrors EscalationPolicy.decideEscalation's contract:
 * always returns a concrete reason, never throws.
 */
export function decideJevEscalation(input: JevEscalationInput): JevEscalationDecision {
  const cfg = tradingSafety as unknown as {
    jevEscalationConfidenceThreshold: number;
    jevEscalationRelevanceThreshold: number;
    jevHighStakesCredibility: number;
    jevHighStakesImpact: number;
  };
  const confThreshold = Number(cfg.jevEscalationConfidenceThreshold) || 0.75;
  const relThreshold = Number(cfg.jevEscalationRelevanceThreshold) || 0.6;
  const hsCred = Number(cfg.jevHighStakesCredibility) || 0.8;
  const hsImpact = Number(cfg.jevHighStakesImpact) || 7.0;

  if (!input.jevScore) {
    return {
      escalateToLlm: true,
      reason: 'Jev score unavailable (no key, failed, timed out, or imperfect data) — existing LLM path unchanged',
    };
  }
  const score = input.jevScore;

  // High-stakes articles always get full LLM reasoning, however confident Jev is.
  if (input.credibility >= hsCred && score.impactScore >= hsImpact) {
    return {
      escalateToLlm: true,
      reason: `high-stakes article (credibility ${input.credibility.toFixed(2)} >= ${hsCred}, impact ${score.impactScore.toFixed(1)} >= ${hsImpact}) — LLM reasoning warranted`,
    };
  }

  if (score.minConfidence >= confThreshold && score.relevantProb >= relThreshold) {
    return {
      escalateToLlm: false,
      reason: `Jev confident (min confidence ${score.minConfidence.toFixed(2)} >= ${confThreshold}, P(relevant) ${score.relevantProb.toFixed(2)} >= ${relThreshold}) — LLM skipped`,
    };
  }

  return {
    escalateToLlm: true,
    reason: `Jev confidence below threshold (min confidence ${score.minConfidence.toFixed(2)} < ${confThreshold} or P(relevant) ${score.relevantProb.toFixed(2)} < ${relThreshold}) — escalating to LLM`,
  };
}

/**
 * Build a full AIAnalysisResult from an accepted Jev score. Deterministic fields
 * use the same derivations as buildLocalFirstNewsAnalysis; scored fields use the
 * same mapping as the Phase 1 agreement ledger. The reasoning string honestly
 * names Jev as the source.
 */
export function buildJevAnalysisResult(
  article: NormalizedArticle,
  score: JevNewsScore,
  opts: {
    symbol: string;
    category: string;
    impactScore01: number;
    timeHorizon: string;
    isNewCluster: boolean;
    priorArticleCount: number;
    credibility: number;
  },
): AIAnalysisResult {
  const mapped = mapJevScoreToAnalysisFields(score);
  const novelty = deriveNovelty(opts.isNewCluster, opts.priorArticleCount);
  const risk = deriveRiskAssessment(opts.credibility, mapped.contradictoryEvidence, novelty, tradingSafety.newsRiskVetoThreshold);
  return {
    symbol: looksLikeListedTicker(opts.symbol) ?? 'UNKNOWN',
    headline: article.title,
    source: article.source,
    timestamp: article.publishedAt,
    category: opts.category,
    sentimentScore: mapped.sentimentScore,
    marketImpactScore: mapped.marketImpactScore,
    confidence: mapped.confidence,
    affectedSectors: [],
    tradingBias: mapped.tradingBias,
    reasoning: `[Jev] ${score.model} scored sentiment=${score.sentiment} (conf ${score.sentimentConf.toFixed(2)}), impact ${score.impactScore.toFixed(1)}/10, P(relevant) ${score.relevantProb.toFixed(2)}. LLM skipped per confidence-gated escalation.`,
    riskFlags: [],
    materiality: deriveMateriality(opts.impactScore01),
    novelty,
    marketSurprise: mapped.marketSurprise,
    expectedHorizon: mapTimeHorizonToExpectedHorizon(opts.timeHorizon),
    catalystType: mapCategoryToCatalystType(opts.category),
    contradictoryEvidence: mapped.contradictoryEvidence,
    riskLevel: risk.riskLevel,
    riskScore: risk.riskScore,
    riskVeto: risk.riskVeto,
    riskVetoReason: risk.riskVetoReason,
  };
}
