/**
 * Phase F6 — maps a News prediction's expectedHorizon to a concrete evaluation-due duration.
 * The actual evaluation math (real historical bars, genuine MFE/MAE, WIN/LOSS/N_A outcome) is
 * NOT duplicated here - it reuses PredictionOutcomeEvaluator.ts's existing evaluatePrediction(),
 * the same real-bars mechanism already used for Technical/Fundamental/Macro/Kronos predictions,
 * extended to also handle the 'news_predictions' source table. See PredictionOutcomeEvaluator.ts.
 */
import type { ExpectedHorizon } from './NewsIntelligence';

export interface HorizonDurations {
  intradayMs: number;
  shortTermMs: number;
  mediumTermMs: number;
  longerTermMs: number;
}

/** How long after creation a prediction becomes eligible for evaluation. UNKNOWN falls back to
 * the short-term window - it is genuinely unclear how long to wait, so a conservative middle
 * ground is used rather than guessing either extreme. */
export function resolveEvaluationDueMs(horizon: ExpectedHorizon, durations: HorizonDurations): number {
  switch (horizon) {
    case 'INTRADAY': return durations.intradayMs;
    case 'SHORT_TERM': return durations.shortTermMs;
    case 'MEDIUM_TERM': return durations.mediumTermMs;
    case 'LONGER_TERM': return durations.longerTermMs;
    case 'UNKNOWN': return durations.shortTermMs;
  }
}
