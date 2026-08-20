/**
 * Strictly POST-RUN retrospective analysis (labeled AFTER-THE-FACT ANALYSIS everywhere it's
 * surfaced). Must only ever be called once a replay has reached a terminal status - never during
 * processTimestamp(). Looks at bars *after* the rejection timestamp, which the decision loop was
 * never allowed to see (InformationCutoff would throw) - that's the whole point: this is exactly
 * the information Argus did NOT have, used here only to grade a past decision, never to make one.
 *
 * Scope, stated honestly: covers consensus (NO_CHIEF_APPROVAL) rejections only, captured in
 * FullArgusReplayEngine.ts's `session.rejectionsForRetrospective`. Risk-gate rejections and
 * discovery-screen exclusions are not covered by this pass.
 */
import type { ResearchBar } from '../research/ohlcvTypes';
import { replaySafety } from './replaySafety';

export interface RejectionRecord {
  symbol: string;
  timestamp: number;
  reason: string;
  referencePrice: number;
}

export type MissedOpportunityClassification = 'MISSED_OPPORTUNITY' | 'CORRECTLY_AVOIDED' | 'INCONCLUSIVE';

export interface MissedOpportunityRecord {
  symbol: string;
  timestamp: number;
  reason: string;
  referencePrice: number;
  horizonBars: number;
  barsAvailableAfterRejection: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  returnAtHorizonPct: number | null;
  classification: MissedOpportunityClassification;
  label: 'AFTER-THE-FACT ANALYSIS';
}

/**
 * `allBars` must be the FULL bar series for the symbol (not point-in-time filtered) - this
 * function is only ever safe to call after the replay loop has finished with every timestamp.
 */
export function analyzeMissedOpportunities(
  rejections: RejectionRecord[],
  barsBySymbol: Map<string, ResearchBar[]>,
  opts?: { horizonBars?: number; favorableMovePct?: number },
): MissedOpportunityRecord[] {
  const horizonBars = opts?.horizonBars ?? replaySafety.missedOpportunityHorizonBars;
  const favorableMovePct = opts?.favorableMovePct ?? replaySafety.missedOpportunityFavorableMovePct;

  return rejections.map((rej) => {
    const allBars = barsBySymbol.get(rej.symbol.toUpperCase()) || [];
    const after = allBars.filter((b) => b.timestamp > rej.timestamp).slice(0, horizonBars);
    if (after.length === 0 || rej.referencePrice <= 0) {
      return {
        symbol: rej.symbol,
        timestamp: rej.timestamp,
        reason: rej.reason,
        referencePrice: rej.referencePrice,
        horizonBars,
        barsAvailableAfterRejection: after.length,
        maxFavorableExcursionPct: 0,
        maxAdverseExcursionPct: 0,
        returnAtHorizonPct: null,
        classification: 'INCONCLUSIVE',
        label: 'AFTER-THE-FACT ANALYSIS',
      };
    }
    const highs = after.map((b) => b.high);
    const lows = after.map((b) => b.low);
    const maxFavorableExcursionPct = ((Math.max(...highs) - rej.referencePrice) / rej.referencePrice) * 100;
    const maxAdverseExcursionPct = ((Math.min(...lows) - rej.referencePrice) / rej.referencePrice) * 100;
    const returnAtHorizonPct = ((after[after.length - 1].close - rej.referencePrice) / rej.referencePrice) * 100;
    const classification: MissedOpportunityClassification =
      after.length < horizonBars
        ? 'INCONCLUSIVE'
        : maxFavorableExcursionPct >= favorableMovePct
          ? 'MISSED_OPPORTUNITY'
          : 'CORRECTLY_AVOIDED';
    return {
      symbol: rej.symbol,
      timestamp: rej.timestamp,
      reason: rej.reason,
      referencePrice: rej.referencePrice,
      horizonBars,
      barsAvailableAfterRejection: after.length,
      maxFavorableExcursionPct: Number(maxFavorableExcursionPct.toFixed(4)),
      maxAdverseExcursionPct: Number(maxAdverseExcursionPct.toFixed(4)),
      returnAtHorizonPct: Number(returnAtHorizonPct.toFixed(4)),
      classification,
      label: 'AFTER-THE-FACT ANALYSIS',
    };
  });
}
