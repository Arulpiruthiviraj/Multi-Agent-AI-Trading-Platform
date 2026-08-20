/**
 * Point-in-time technical assessment for historical evaluation.
 * Reuses production indicator engines — no EventBus, no live agent loop.
 *
 * Delegates its rule math entirely to technicalSignal.ts's evaluateTechnicalSignals() — the same
 * pure extraction the live tick-driven TechnicalAgent.ts calls (see
 * TechnicalAgent.checkStrategies-vs-technicalSignal.test.ts). This file used to carry its own
 * reimplementation of the three strategy rules, which had drifted from the live agent in two
 * concrete ways: the overbought rule fired at rsi>70 instead of live's rsi>75, and both the
 * mean-reversion and overbought confidence formulas used RSI alone instead of live's
 * (rsiStrength + bbStrength) / 2. Delegating removes that drift instead of re-fixing a second
 * copy of the same math.
 */
import type { ResearchBar } from '../research/ohlcvTypes';
import { quantThresholds } from '../config/quantThresholds';
import { evaluateTechnicalSignals } from '../services/technicalSignal';

export interface ReplayTechnicalSnapshot {
  status: 'PARTIAL';
  reason: string;
  currentPrice: number;
  rsi: number;
  sma20: number;
  sma50: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  bbUpper: number;
  bbLower: number;
  bbMiddle: number;
  side: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  engines: string[];
}

/**
 * Evaluate technical signals on point-in-time closes (bars already filtered to timestamp < T).
 * Uses the exact live TechnicalAgent rule math (technicalSignal.ts) — no reimplementation.
 */
export function evaluateReplayTechnical(visible: ResearchBar[]): ReplayTechnicalSnapshot | null {
  if (visible.length < quantThresholds.technicalHistoryBars) return null;
  const prices = visible.map((b) => b.close);
  const currentPrice = prices[prices.length - 1];
  const { indicators, momentumBreakout, meanReversion, overbought } = evaluateTechnicalSignals(prices);

  // At most one of these can fire (the RSI ranges are mutually exclusive by construction), so
  // picking in this order is equivalent to live TechnicalAgent evaluating all three independently.
  const fired = momentumBreakout ?? meanReversion ?? overbought;

  return {
    status: 'PARTIAL',
    reason: 'RSI/MACD/SMA/Bollinger on PIT bars via the same technicalSignal.ts rule math the live TechnicalAgent uses; not the full live tick-driven loop or EventBus',
    currentPrice,
    rsi: indicators.rsi,
    sma20: indicators.sma20,
    sma50: indicators.sma50,
    macd: indicators.macd,
    macdSignal: indicators.macdSignal,
    macdHistogram: indicators.macd - indicators.macdSignal,
    bbUpper: indicators.bbUpper,
    bbLower: indicators.bbLower,
    bbMiddle: (indicators.bbUpper + indicators.bbLower) / 2,
    side: fired?.side ?? 'HOLD',
    confidence: fired?.confidence ?? 0,
    engines: ['RSIEngine', 'MACDEngine', 'SMA', 'BollingerBands'],
  };
}
