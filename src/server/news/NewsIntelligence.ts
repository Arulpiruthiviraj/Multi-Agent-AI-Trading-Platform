/**
 * Phase F3 — structured, evidence-derived News intelligence dimensions.
 *
 * Every function here is pure and deterministic, deriving its output from real upstream signals
 * already computed elsewhere in the pipeline (NewsClassifier's category, NewsImpactEngine's
 * impactScore/timeHorizon, NewsClusterEngine's real corroboration count) - never fabricated or
 * LLM-guessed for dimensions the LLM has no way to actually know (e.g. novelty requires knowing
 * how many other articles already cover this event, which only NewsClusterEngine tracks).
 */

export type Materiality = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ExpectedHorizon = 'INTRADAY' | 'SHORT_TERM' | 'MEDIUM_TERM' | 'LONGER_TERM' | 'UNKNOWN';
export type CatalystType =
  | 'EARNINGS' | 'GUIDANCE' | 'M_AND_A' | 'PRODUCT' | 'PARTNERSHIP' | 'REGULATORY' | 'LEGAL'
  | 'MANAGEMENT' | 'MACRO' | 'ANALYST' | 'CAPITAL_RETURN' | 'SUPPLY_CHAIN' | 'COMPETITIVE' | 'OTHER';

/** impactScore is NewsImpactEngine's real 0-1 output - this only rescales it into named buckets. */
export function deriveMateriality(impactScore01: number): Materiality {
  if (impactScore01 >= 0.85) return 'CRITICAL';
  if (impactScore01 >= 0.6) return 'HIGH';
  if (impactScore01 >= 0.3) return 'MEDIUM';
  return 'LOW';
}

// NewsClassifier's categories are a small, real, already-computed keyword classification - this
// maps them onto the richer Phase F catalyst taxonomy rather than asking anything to re-guess it.
const CATEGORY_TO_CATALYST_TYPE: Record<string, CatalystType> = {
  Earnings: 'EARNINGS',
  Dividend: 'CAPITAL_RETURN',
  'M&A': 'M_AND_A',
  Macro: 'MACRO',
  Legal: 'LEGAL',
  Technology: 'PRODUCT',
  General: 'OTHER',
};

export function mapCategoryToCatalystType(category: string): CatalystType {
  return CATEGORY_TO_CATALYST_TYPE[category] ?? 'OTHER';
}

// NewsImpactEngine.timeHorizon is a small, real, already-computed string - mapped onto the
// Phase F horizon taxonomy. Values it does not currently produce ('Immediate', 'Long Term') are
// still handled so this stays correct if that engine's own value set changes later.
const TIME_HORIZON_TO_EXPECTED_HORIZON: Record<string, ExpectedHorizon> = {
  Immediate: 'INTRADAY',
  Intraday: 'INTRADAY',
  Swing: 'MEDIUM_TERM',
  'Long Term': 'LONGER_TERM',
};

export function mapTimeHorizonToExpectedHorizon(timeHorizon: string): ExpectedHorizon {
  return TIME_HORIZON_TO_EXPECTED_HORIZON[timeHorizon] ?? 'UNKNOWN';
}

/**
 * Novelty is derived from real clustering state (NewsClusterEngine), not guessed: a brand-new
 * event is maximally novel; each additional corroborating article lowers novelty, since the
 * information is no longer newly-arriving - it is being independently confirmed.
 */
export function deriveNovelty(isNewCluster: boolean, priorArticleCount: number): number {
  if (isNewCluster) return 1;
  const NOVELTY_FLOOR = 0.05;
  return Math.max(NOVELTY_FLOOR, 1 / (priorArticleCount + 1));
}

/**
 * Local-first (non-LLM) market-surprise proxy. This is deliberately a coarse heuristic, not a
 * true "was this priced in" assessment (which would need options-implied-volatility or
 * analyst-estimate data this pipeline does not have) - documented honestly rather than presented
 * as calibrated. Escalated (LLM) analysis asks the model directly instead of using this proxy,
 * since the model can reason from its training knowledge about whether an event was expected.
 */
export function deriveLocalMarketSurpriseProxy(novelty: number, sentimentMagnitude01: number): number {
  return Math.max(0, Math.min(1, novelty * Math.min(1, sentimentMagnitude01 * 1.5)));
}

/**
 * Phase F4 — risk assessment, conceptually separate from the directional (tradingBias) output.
 * A bullish article can still carry high risk if the underlying information is uncertain; a
 * bearish article can be low-risk if it is well-corroborated and credible. riskLevel/riskScore
 * are about how much to TRUST the information, not how big its market impact would be if true
 * (that is what materiality already captures - deliberately not duplicated as a separate
 * "expectedMoveClass" field per the Phase F spec, since it would just restate materiality).
 *
 * Deterministic from three real, already-computed inputs: source credibility (NewsCredibilityEngine),
 * contradictoryEvidence (LLM-reasoned when escalated, false on the local-first path), and novelty
 * (a brand-new, as-yet-uncorroborated report carries more uncertainty than one several outlets
 * have already independently confirmed).
 */
export interface RiskAssessment {
  riskLevel: Materiality;
  riskScore: number;
  riskVeto: boolean;
  riskVetoReason: string | null;
}

export function deriveRiskAssessment(
  credibility01: number,
  contradictoryEvidence: boolean,
  novelty01: number,
  riskVetoThreshold01: number,
): RiskAssessment {
  const reasons: string[] = [];
  let riskScore = (1 - credibility01) * 0.5;
  if (credibility01 < 0.5) reasons.push(`Low source credibility (${credibility01.toFixed(2)})`);
  if (contradictoryEvidence) {
    riskScore += 0.4;
    reasons.push('Contradictory evidence detected');
  }
  if (novelty01 > 0.7) {
    riskScore += 0.1;
    reasons.push('Brand-new, not yet corroborated by other sources');
  }
  riskScore = Math.max(0, Math.min(1, riskScore));

  const riskLevel = deriveMateriality(riskScore);
  const riskVeto = riskScore >= riskVetoThreshold01;

  return {
    riskLevel,
    riskScore,
    riskVeto,
    riskVetoReason: riskVeto ? reasons.join('; ') || 'Elevated risk score' : null,
  };
}
