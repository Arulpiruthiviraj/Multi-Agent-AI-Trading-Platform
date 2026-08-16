/**
 * ==========================================================
 * Module: strategies/openingRangeBreakout
 *
 * Purpose:
 * Experimental ORB: close beyond the session opening-range high/low with RVOL and VWAP
 * alignment. Opening range is attached on SupportResistanceFeatures and is honestly
 * unavailable on daily bars — this module does not invent an OR from a daily candle.
 *
 * Live vs backtest:
 *   findStrategy() without the live flag; evaluateAll() only if QUANT_ORB_STRATEGY_ENABLED=true.
 *
 * Status: UNVALIDATED. BacktestEngine is long-only.
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

export const openingRangeBreakout: StrategyDefinition = {
  id: 'OPENING_RANGE_BREAKOUT',
  displayName: 'Opening Range Breakout',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND', 'SIDEWAYS_RANGE'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { supportResistance, volume, regime, volatility, currentPrice } = ctx;
    const or = supportResistance.openingRange;
    const orHigh = or.available && or.data ? or.data.high : null;
    const orLow = or.available && or.data ? or.data.low : null;

    const brokeHigh = orHigh !== null && currentPrice > orHigh;
    const brokeLow = orLow !== null && currentPrice < orLow;
    const side: 'BUY' | 'SELL' = brokeLow && !brokeHigh ? 'SELL' : 'BUY';
    const bullish = side === 'BUY';

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check(
      or.available
        ? `Opening range resolved (${t.openingRangeWindowMinutes}m window)`
        : `Opening range available (intraday bars required): ${or.reason ?? 'unavailable'}`,
      or.available && or.data !== null,
    );
    check(
      bullish ? 'Close above opening-range high' : 'Close below opening-range low',
      bullish ? brokeHigh : brokeLow,
    );
    check(
      `RVOL confirmation (>= ${t.rvolBreakout}x)`,
      volume.relativeVolume !== null && volume.relativeVolume >= t.rvolBreakout,
    );
    check(
      bullish ? 'Price above session VWAP' : 'Price below session VWAP',
      volume.vwap.distancePct !== null && (bullish ? volume.vwap.distancePct > 0 : volume.vwap.distancePct < 0),
    );
    check(
      'Directional regime (not fading a range as a default)',
      bullish ? regime.regime === 'BULLISH_TREND' : regime.regime === 'BEARISH_TREND',
    );

    const pdh = supportResistance.previousDay?.high ?? null;
    const pdl = supportResistance.previousDay?.low ?? null;
    check(
      bullish
        ? 'Prior-day high available as range context (not a fabricated PDH)'
        : 'Prior-day low available as range context (not a fabricated PDL)',
      bullish ? pdh !== null : pdl !== null,
    );

    if (!or.available) {
      contradictions.push('No opening range: daily bars cannot produce an ORB. This is HOLD evidence, not a skip of the condition.');
    }
    if (regime.regime === 'SIDEWAYS_RANGE' && (brokeHigh || brokeLow)) {
      contradictions.push('Regime is SIDEWAYS_RANGE on an OR break — elevated false-break risk.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);
    const atr = volatility.atr;
    const structural = bullish ? orHigh : orLow;

    return {
      strategy: 'OPENING_RANGE_BREAKOUT',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Price closes back inside the opening range (false breakout).',
        `RVOL collapses below ${t.rvolBreakout}x.`,
      ],
      stop: structural !== null && atr
        ? { price: bullish ? structural - atr : structural + atr, basis: '1x ATR beyond the broken opening-range extreme.' }
        : { price: structural, basis: 'Opening-range extreme if resolved; otherwise no stop level.' },
      target: atr
        ? { price: currentPrice + (bullish ? 2 * atr : -2 * atr), basis: '2x ATR measured move (range width is not invented when OR is unavailable).' }
        : { price: null, basis: 'No ATR for a measured target.' },
      applicableRegimes: openingRangeBreakout.applicableRegimes,
    };
  },
};
