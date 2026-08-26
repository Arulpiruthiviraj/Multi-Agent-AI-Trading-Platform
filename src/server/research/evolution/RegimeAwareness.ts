/**
 * Regime-aware evolution (Section 19). Reuses the LIVE RegimeEngine.classifyRegime() — the same
 * function QuantSignalAgent already calls — rather than strategiesEngine's own metadata-only
 * StrategyRegimeTag with no detector behind it. Tags a candidate's real detected regime so a
 * future evolution cycle can ask "does this candidate need different parameters under a
 * different regime" — the regime-specific candidate itself still goes through the exact same
 * validation pipeline as any other (Section 19's own explicit requirement: no special-casing).
 */
import type { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { classifyRegime, type RegimeLabel } from '../../quant/RegimeEngine';
import type { StrategyRegimeTag } from '../../strategiesEngine/core/types';

const REGIME_LABEL_TO_TAG: Record<RegimeLabel, StrategyRegimeTag> = {
  BULLISH_TREND: 'TRENDING_UP',
  BEARISH_TREND: 'TRENDING_DOWN',
  SIDEWAYS_RANGE: 'RANGING',
};

/** Real regime detection for the dataset a candidate is about to be evaluated on — honest null
 *  (never fabricated) when there isn't enough real bar history yet. */
export function detectRegimeTag(bars: Bar[]): { tag: StrategyRegimeTag | null; confidence: number; insufficientData: boolean } {
  const regime = classifyRegime(bars);
  if (regime.insufficientData) return { tag: null, confidence: 0, insufficientData: true };
  return { tag: REGIME_LABEL_TO_TAG[regime.regime], confidence: regime.confidence, insufficientData: false };
}
