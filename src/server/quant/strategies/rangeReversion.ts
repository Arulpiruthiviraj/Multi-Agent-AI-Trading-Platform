/**
 * ==========================================================
 * Module: strategies/rangeReversion
 *
 * Purpose:
 * Phase 4 - Range Reversion: fades a real, currently-consolidating range at whichever real boundary
 * (nearest support/resistance, from supportResistance.ts's real swing/pivot levels) price is
 * actually closest to - distinct from meanReversion.ts, which fades RSI/Keltner statistical
 * extremes rather than an explicit structural range boundary. Requires the absence of a real
 * volume spike (a real spike is what a genuine breakout looks like - its absence is real evidence
 * the range is still holding, not proof on its own).
 * ==========================================================
 */
import { StrategyContext, StrategyDefinition, StrategyEvaluation, scoreFromConditions } from './types';
import { quantThresholds } from '../../config/quantThresholds';

const NEAR_BOUNDARY_PCT = quantThresholds.nearBoundaryPct;

export const rangeReversion: StrategyDefinition = {
  id: 'RANGE_REVERSION',
  displayName: 'Range Reversion',
  applicableRegimes: ['SIDEWAYS_RANGE'],

  evaluate(ctx: StrategyContext): StrategyEvaluation {
    const { trend, momentum, volume, priceAction, supportResistance, regime } = ctx;
    const { nearestSupport, nearestResistance } = supportResistance.nearest;

    // Direction = whichever real boundary price currently sits closer to (fade toward the opposite side).
    const supportDist = nearestSupport !== null ? Math.abs(nearestSupport.pct) : Infinity;
    const resistanceDist = nearestResistance !== null ? Math.abs(nearestResistance.pct) : Infinity;
    const bullish = supportDist <= resistanceDist; // fading off support => BUY
    const side: 'BUY' | 'SELL' = bullish ? 'BUY' : 'SELL';
    const nearBoundary = bullish ? nearestSupport : nearestResistance;
    const farBoundary = bullish ? nearestResistance : nearestSupport;

    const conditionsMet: string[] = [];
    const conditionsFailed: string[] = [];
    const contradictions: string[] = [];
    const check = (name: string, met: boolean) => (met ? conditionsMet.push(name) : conditionsFailed.push(name));

    check('Range regime confirmed (RANGING market structure + real consolidation)', regime.marketStructure === 'RANGING' && priceAction.consolidating);
    check(
      bullish ? 'Price near the range support boundary' : 'Price near the range resistance boundary',
      nearBoundary !== null && Math.abs(nearBoundary.pct) <= NEAR_BOUNDARY_PCT
    );
    check(
      bullish ? 'RSI showing weakness at the boundary (<=40)' : 'RSI showing strength at the boundary (>=60)',
      bullish ? momentum.rsi <= 40 : momentum.rsi >= 60
    );
    check('No real volume spike (a genuine breakout would show one)', volume.isSpike !== true);
    check(
      'No real structural break in the fade direction (range still holding)',
      bullish ? trend.structure.event !== 'BOS_BEARISH' : trend.structure.event !== 'BOS_BULLISH'
    );

    if (nearBoundary === null) {
      contradictions.push('No real nearest support/resistance level exists yet - this strategy cannot honestly identify a boundary to fade.');
    }
    if (volume.isSpike === true) {
      contradictions.push('A real volume spike is present, which is itself evidence of a genuine breakout attempt rather than range-holding.');
    }

    const totalConditions = conditionsMet.length + conditionsFailed.length;
    const setupScore = scoreFromConditions(conditionsMet, totalConditions);

    return {
      strategy: 'RANGE_REVERSION',
      side,
      setupScore,
      confidence: setupScore / 100,
      conditionsMet,
      conditionsFailed,
      contradictions,
      invalidationConditions: [
        `A real close beyond the ${bullish ? 'support' : 'resistance'} boundary confirms the range is breaking, not holding.`,
        'A real volume spike accompanies the break (genuine breakout, not a fade-worthy range test).',
      ],
      stop: nearBoundary
        ? { price: nearBoundary.level, basis: `Just beyond the real ${bullish ? 'support' : 'resistance'} boundary being faded.` }
        : { price: null, basis: 'No real range boundary available yet to derive a stop.' },
      target: farBoundary
        ? { price: farBoundary.level, basis: `The opposite real range boundary - trading the width of the range.` }
        : { price: null, basis: 'No real opposite range boundary available yet to derive a target.' },
      applicableRegimes: rangeReversion.applicableRegimes,
    };
  },
};
