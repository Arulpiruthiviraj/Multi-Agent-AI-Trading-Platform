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

// Same magnitude ChiefTraderAgent always used: a disagreeing agent pulls the winning side's
// score down by half its own weighted confidence, not a full vote's worth.
const DISAGREEMENT_PENALTY = 0.5;

export class EvidenceAggregator {
  /**
   * Weighted-vote consensus over one symbol's evidence. HOLD ideas neither support nor
   * penalize BUY/SELL - only BUY vs SELL evidence compete with each other. Returns the side
   * (BUY/SELL/HOLD) whose weighted confidence, net of opposing evidence, is highest.
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
      const disagreeing = evidence.filter(e => e.side !== testSide && e.side !== 'HOLD');

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

      const finalConfidence = Math.max(0, Math.min(1, weightedConfidence / (totalWeight || 1)));
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
