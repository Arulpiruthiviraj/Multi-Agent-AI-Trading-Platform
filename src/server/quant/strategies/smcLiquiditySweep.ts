/**
 * ==========================================================
 * Module: strategies/smcLiquiditySweep
 *
 * Purpose:
 * Confluence scorer over SMC features + existing regime/volume. Weights come from
 * config/smcConfluence.json (sum to 100). A wick sweep without CHoCH is scored but recorded
 * as a contradiction — not an automatic fade.
 *
 * Side:
 *   SELL_SIDE_SWEPT (wick below lows, close back up) → BUY candidate
 *   BUY_SIDE_SWEPT  (wick above highs, close back down) → SELL candidate
 *
 * Live vs backtest:
 *   EXPERIMENTAL_STRATEGIES — findStrategy() can backtest it without the live flag.
 *   evaluateAll() includes it only when QUANT_SMC_STRATEGY_ENABLED=true.
 *   BacktestEngine is long-only: SELL candidates will not open shorts.
 *
 * Status: UNVALIDATED (no walk-forward OOS for this definition).
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation } from './types';
import { smcConfluence } from '../../config/smcConfluence';
import type { SmcFeatures } from '../indicators/smc';

/** Neutral snapshot when StrategyContext.smc was omitted (older unit fixtures). All conditions fail honestly. */
function emptySmc(): SmcFeatures {
  return {
    structure: { trend: 'SIDEWAYS', event: 'NONE', lastSwingHigh: null, lastSwingLow: null },
    liquidity: { buySide: null, sellSide: null, equalHighs: false, equalLows: false },
    sweep: {
      kind: 'NONE', isTradeSignal: false, sweptLevel: null, sweepExtreme: null,
      closedBackInside: false, detail: 'SMC features not computed',
    },
    displacement: { present: false, direction: null, rangeMultiple: null, barIndex: null },
    orderBlock: { side: null, low: null, high: null, overlappingPrice: false, filled: null },
    fairValueGap: { side: null, low: null, high: null, overlappingPrice: false, filled: null },
    trap: { kind: 'NONE', isIntentionalManipulation: false, detail: 'SMC features not computed' },
  };
}

export const smcLiquiditySweep: StrategyDefinition = {
  id: 'SMC_LIQUIDITY_SWEEP',
  displayName: 'SMC Liquidity Sweep',
  applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND', 'SIDEWAYS_RANGE'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const smc = ctx.smc ?? emptySmc();
    const w = smcConfluence;
    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    let score = 0;

    const add = (name: string, met: boolean, points: number) => {
      if (met) {
        conditionsMet.push(name);
        score += points;
      } else {
        conditionsFailed.push(name);
      }
    };

    const liquidityIdentified = smc.liquidity.buySide !== null || smc.liquidity.sellSide !== null;
    add('Liquidity identified (swing or equal high/low)', liquidityIdentified, w.liquidityIdentified);

    const swept = smc.sweep.kind !== 'NONE' && smc.sweep.closedBackInside;
    add('Liquidity swept (wick beyond level, close back inside — not a trade by itself)', swept, w.liquiditySwept);

    const bullishSetup = smc.sweep.kind === 'SELL_SIDE_SWEPT';
    const bearishSetup = smc.sweep.kind === 'BUY_SIDE_SWEPT';
    const side: 'BUY' | 'SELL' = bearishSetup && !bullishSetup ? 'SELL' : 'BUY';

    const chochOk = bullishSetup
      ? smc.structure.event === 'CHOCH_BULLISH'
      : bearishSetup
        ? smc.structure.event === 'CHOCH_BEARISH'
        : false;
    add('CHoCH confirmation in reversal direction (required — sweep without CHoCH is ignored as a trade)', chochOk, w.chochConfirmed);

    const dispOk = smc.displacement.present && (
      (side === 'BUY' && smc.displacement.direction === 'UP') ||
      (side === 'SELL' && smc.displacement.direction === 'DOWN')
    );
    add('Displacement in trade direction', dispOk, w.displacement);

    const obOk = (side === 'BUY' && smc.orderBlock.side === 'BULLISH') || (side === 'SELL' && smc.orderBlock.side === 'BEARISH');
    add('Order block in trade direction', obOk, w.orderBlock);

    const fvgOk = (side === 'BUY' && smc.fairValueGap.side === 'BULLISH' && smc.fairValueGap.filled !== true)
      || (side === 'SELL' && smc.fairValueGap.side === 'BEARISH' && smc.fairValueGap.filled !== true);
    add('Unfilled FVG in trade direction', fvgOk, w.fvg);

    const rvol = ctx.volume.relativeVolume;
    add(
      `Volume confirmation (RVOL >= ${w.rvolConfirmation})`,
      rvol !== null && rvol >= w.rvolConfirmation,
      w.volumeConfirmation,
    );

    const regimeOk = side === 'BUY' ? ctx.regime.regime === 'BULLISH_TREND' : ctx.regime.regime === 'BEARISH_TREND';
    add(
      'Same-timeframe regime alignment (not a higher-timeframe read — this stack evaluates one bar timeframe per cycle)',
      regimeOk,
      w.regimeAlignment,
    );

    if (!swept) {
      contradictions.push('No liquidity sweep: SMC does not treat BOS/CHoCH or an indicator print as an automatic entry.');
    }
    if (swept && !chochOk) {
      contradictions.push('Sweep without CHoCH confirmation — wait; do not fade the breakout on the sweep bar alone.');
    }
    if (smc.trap.kind !== 'NONE') {
      contradictions.push(smc.trap.detail);
    }
    if (smc.sweep.isTradeSignal) {
      contradictions.push('Invariant violated: sweep.isTradeSignal must be false.');
    }

    const setupScore = Math.min(100, Math.round(score));
    const atr = ctx.volatility.atr;
    const extreme = smc.sweep.sweepExtreme;
    const opposing = side === 'BUY' ? smc.liquidity.buySide : smc.liquidity.sellSide;

    return {
      strategy: 'SMC_LIQUIDITY_SWEEP',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        'Price closes back through the sweep extreme (continuation, not a reversal).',
        'CHoCH prints against the setup after entry.',
      ],
      stop: extreme !== null && atr
        ? {
            price: side === 'BUY' ? extreme - atr : extreme + atr,
            basis: `1x ATR ${side === 'BUY' ? 'below' : 'above'} the sweep extreme (${extreme.toFixed(2)}).`,
          }
        : { price: null, basis: 'No sweep extreme or ATR available to place a stop beyond invalidation.' },
      target: opposing
        ? { price: opposing.price, basis: `Opposing liquidity (${opposing.kind} at ${opposing.price.toFixed(2)}).` }
        : atr
          ? { price: ctx.currentPrice + (side === 'BUY' ? 2 * atr : -2 * atr), basis: '2x ATR measured move (no opposing liquidity pool).' }
          : { price: null, basis: 'No opposing liquidity or ATR for a target.' },
      applicableRegimes: smcLiquiditySweep.applicableRegimes,
    };
  },
};
