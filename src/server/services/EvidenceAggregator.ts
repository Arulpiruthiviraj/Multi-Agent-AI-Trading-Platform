/**
 * ==========================================================
 * Module: EvidenceAggregator
 *
 * Purpose:
 * Normalizes independent agents' raw trade ideas into one structured, weighted-vote
 * consensus. This is a pure extraction of the weighted-voting math that used to live
 * inline (and duplicated three times) inside ChiefTraderAgent.evaluateConsensus() - the
 * approval math and thresholds are unchanged, this just gives it a real, independently
 * testable, reusable shape instead of an ad-hoc loop building formatted strings.
 * ==========================================================
 */

import { tradingSafety } from '../config/tradingSafety';

export interface Evidence {
  traceId: string;
  symbol: string;
  side: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0-1
  agent: string;
  reasoning: string;
  currentPrice?: number;
  weight: number; // already resolved by the caller (agentPerformanceStats-backed or default)
}

export interface AggregationResult {
  side: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0-1, weighted
  reasoning: string;
  currentPrice?: number;
  agreements: Evidence[];
  disagreements: Evidence[];
}

export const DISAGREEMENT_PENALTY = tradingSafety.disagreementPenalty;

export function netConfidenceFromVotes(
  agreeing: Array<{ confidence: number; weight: number }>,
  disagreeing: Array<{ confidence: number; weight: number }>,
): number {
  let weightedConfidence = 0;
  let totalWeight = 0;
  for (const e of agreeing) {
    weightedConfidence += e.confidence * e.weight;
    totalWeight += e.weight;
  }
  for (const e of disagreeing) {
    weightedConfidence -= e.confidence * e.weight * DISAGREEMENT_PENALTY;
    totalWeight += e.weight;
  }
  return Math.max(0, Math.min(1, weightedConfidence / (totalWeight || 1)));
}

export class EvidenceAggregator {
  /**
   * Weighted-vote consensus over one symbol's evidence. BUY vs SELL compete directly.
   * A HOLD with real confidence (> 0) is a genuine "do not trade" vote and penalizes both
   * directional sides the same way a contrary BUY/SELL would. HOLD at confidence 0 is the
   * DATA_UNAVAILABLE shape (FundamentalAgent/MacroAgent when a provider is missing or
   * rate-limited) and is excluded from the denominator so a dead agent cannot dilute a
   * real directional vote.
   */
  static aggregate(evidence: Evidence[]): AggregationResult {
    let bestSide: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    let bestConfidence = 0;
    let bestReasoning = '';
    let bestPrice: number | undefined;
    let bestAgreements: Evidence[] = [];
    let bestDisagreements: Evidence[] = [];

    for (const testSide of ['BUY', 'SELL'] as const) {
      const agreeing = evidence.filter(e => e.side === testSide);
      const directionalDisagreeing = evidence.filter(e => e.side !== testSide && e.side !== 'HOLD');
      const holdPenalties = evidence.filter(e => e.side === 'HOLD' && e.confidence > 0);
      const disagreeing = [...directionalDisagreeing, ...holdPenalties];

      const finalConfidence = netConfidenceFromVotes(agreeing, disagreeing);
      if (finalConfidence > bestConfidence) {
        bestConfidence = finalConfidence;
        bestSide = testSide;
        bestReasoning = agreeing[0]?.reasoning || 'Consensus formed';
        bestPrice = agreeing.find(e => typeof e.currentPrice === 'number' && Number.isFinite(e.currentPrice) && e.currentPrice > 0)?.currentPrice;
        bestAgreements = agreeing;
        bestDisagreements = disagreeing;
      }
    }

    return {
      side: bestSide,
      confidence: bestConfidence,
      reasoning: bestReasoning,
      currentPrice: bestPrice,
      agreements: bestAgreements,
      disagreements: bestDisagreements,
    };
  }
}
