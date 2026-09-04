/**
 * ==========================================================
 * Module: TrendFollowingExitEvaluator
 *
 * Purpose:
 * Exit-aware historical evaluation for TREND_FOLLOWING (2026-09-04, evaluation-horizon-mismatch
 * follow-up). The generic PredictionOutcomeEvaluator grades every prediction by checking the price
 * at one fixed future timestamp - correct for a strategy with a real fixed target, but TREND_
 * FOLLOWING deliberately has none (see trendFollowing.ts's own header/target field: "no fixed
 * target; trail the stop"). Grading it that way measures an arbitrary snapshot of a still-open
 * position, not the strategy's own realized outcome - confirmed live (2026-09-04 controlled
 * comparison): moving the fixed check from 60min to a fixed 7 days made TREND_FOLLOWING's measured
 * win rate WORSE (46.5%->27.0%), the opposite of PULLBACK_CONTINUATION's result on the same change,
 * which is exactly the signature of "wrong evaluation model", not "wrong horizon length".
 *
 * This walks forward day-by-day from entry using the SAME real historical bars mechanism the
 * generic evaluator uses (HistoricalDataGateway), reproducing the strategy's own actual exit rule:
 *   - trailing stop = SMA50 of daily closes, recomputed EACH day from only that day's and earlier
 *     closes (point-in-time safe - never uses a close that would not yet have existed)
 *   - ADX-fade invalidation = real double-smoothed DMI/ADX (trend.ts's calculateDMI, the SAME
 *     function trendFollowing.ts's own live evaluate() reads), falling below quantThresholds.
 *     minAdxTrending
 * A detected exit signal on day T fills at day T+1's open (NEXT_BAR_OPEN, the same reviewed,
 * promotable convention canonicalNextBarEngine.ts already uses for CORE strategies), with the same
 * honest gap-through handling: if the next day's open already gapped past the stop, that worse
 * price is used, never an unrealistic exact-stop fill.
 *
 * NOT modeled (explicitly, not silently): the strategy's third invalidation condition, "a
 * structural CHoCH event" (trendFollowing.ts's own text) - real swing-structure break-of-structure
 * detection is a real, separate, more involved pattern-recognition problem than SMA/ADX math, and
 * building it correctly was out of scope for this pass. A position that would have been closed by a
 * real CHoCH the SMA50/ADX checks below did not yet catch will show as STILL_OPEN/held longer than
 * a full model would - this is a known, named limitation of this evaluator, not a hidden gap.
 *
 * Governance: research/observability only - never imports OMS/RiskEngine/BrokerManager, never
 * places or influences a live order. Reuses TechnicalIndicators.calculateSMA and trend.ts's
 * calculateDMI rather than reimplementing indicator math a second time.
 * ==========================================================
 */
import { historicalDataGateway, type Bar } from '../engines/backtest/HistoricalDataGateway';
import { TechnicalIndicators } from '../engines/TechnicalIndicators';
import { calculateDMI } from '../quant/indicators/trend';
import { quantThresholds } from '../config/quantThresholds';

const SMA_PERIOD = 50;
/** Enough trailing daily bars to compute a real SMA50 at the entry day itself - calendar days, not
 *  trading days, so this deliberately over-fetches a bit to absorb weekends/holidays. */
const LOOKBACK_BUFFER_MS = 90 * 24 * 60 * 60 * 1000;

export type TrendFollowingExitReason = 'SMA50_TRAIL_STOP' | 'ADX_FADE' | 'STILL_OPEN' | 'INSUFFICIENT_DATA';

export interface TrendFollowingExitResult {
  exitReason: TrendFollowingExitReason;
  entryPrice: number;
  entryTimestamp: string;
  exitPrice: number | null;
  exitTimestamp: string | null;
  holdingPeriodDays: number | null;
  /** Realized if exitPrice is set; otherwise unrealized mark-to-market at the evaluation window's
   *  end - always labeled by exitReason, never presented as a closed outcome when it isn't one. */
  actualReturn: number | null;
  outcome: 'WIN' | 'LOSS' | 'STILL_OPEN' | 'N_A';
  /** The real price actualReturn was computed against - exitPrice when closed, otherwise the last
   *  available bar's close (unrealized mark-to-market). Exposed explicitly so callers never need to
   *  reverse-engineer it from entryPrice + actualReturn. */
  finalPrice: number;
}

/**
 * Walks forward from entryTimeMs using real daily bars, evaluating the SAME two deterministic exit
 * conditions trendFollowing.ts's own invalidationConditions/stop describe. Returns null only when
 * there is no real bar data at all for the symbol/window (never fabricates a result).
 */
export async function evaluateTrendFollowingExit(
  symbol: string,
  side: 'BUY' | 'SELL',
  entryTimeMs: number,
  maxHorizonMs: number,
): Promise<TrendFollowingExitResult | null> {
  const startMs = entryTimeMs - LOOKBACK_BUFFER_MS;
  const endMs = entryTimeMs + maxHorizonMs;
  let bars: Bar[];
  try {
    bars = await historicalDataGateway.getBars(symbol, '1Day', startMs, endMs);
    if (bars.length < SMA_PERIOD + 2) {
      await historicalDataGateway.ensureBars(symbol, '1Day', startMs, endMs);
      bars = await historicalDataGateway.getBars(symbol, '1Day', startMs, endMs);
    }
  } catch {
    return null;
  }
  if (bars.length < SMA_PERIOD + 2) return null;

  const entryIdx = bars.findIndex((b) => b.timestamp >= entryTimeMs);
  if (entryIdx < SMA_PERIOD - 1) return null; // not enough real trailing history to seed SMA50 at entry

  const isLong = side === 'BUY';
  const entryPrice = bars[entryIdx].close;
  const entryTimestamp = new Date(bars[entryIdx].timestamp).toISOString();

  // The live strategy only ever enters when trend.dmi.adx >= minAdxTrending is already true (its
  // own entry gate) - so "ADX fade" means a real trend that WAS confirmed strong subsequently
  // weakening, never "hasn't built up trend strength yet". Without this, a freshly-started real
  // trend reads as low-ADX during its own warm-up window and would falsely "fade" on day one.
  let adxEverConfirmedTrending = false;

  for (let i = entryIdx + 1; i < bars.length; i++) {
    const closesUpToI = bars.slice(Math.max(0, i - SMA_PERIOD + 1), i + 1).map((b) => b.close);
    if (closesUpToI.length < SMA_PERIOD) continue; // point-in-time safe - never compute on a short window
    const trailStop = TechnicalIndicators.calculateSMA(closesUpToI, SMA_PERIOD);

    const smaStopHit = isLong ? bars[i].close < trailStop : bars[i].close > trailStop;

    const dmiWindowStart = Math.max(0, i - 30);
    const dmi = calculateDMI(
      bars.slice(dmiWindowStart, i + 1).map((b) => b.high),
      bars.slice(dmiWindowStart, i + 1).map((b) => b.low),
      bars.slice(dmiWindowStart, i + 1).map((b) => b.close),
    );
    const isTrendingNow = !!dmi && dmi.adx >= quantThresholds.minAdxTrending;
    if (isTrendingNow) adxEverConfirmedTrending = true;
    const adxFaded = adxEverConfirmedTrending && !!dmi && !isTrendingNow;

    if (smaStopHit || adxFaded) {
      const execIdx = i + 1;
      if (execIdx >= bars.length) break; // detected on the last available bar - no next-bar fill exists yet
      const nextOpen = bars[execIdx].open;
      // Honest gap-through handling, same convention as canonicalNextBarEngine.ts: if the exit-day
      // open already moved past the trigger level, use that worse price, never an unrealistic
      // exact-level fill.
      const exitPrice = smaStopHit
        ? (isLong ? Math.min(nextOpen, trailStop) : Math.max(nextOpen, trailStop))
        : nextOpen;
      const exitTimestamp = new Date(bars[execIdx].timestamp).toISOString();
      const holdingPeriodDays = Math.round((bars[execIdx].timestamp - bars[entryIdx].timestamp) / (24 * 60 * 60 * 1000));
      const rawReturn = (exitPrice - entryPrice) / entryPrice;
      const actualReturn = isLong ? rawReturn : -rawReturn;
      return {
        exitReason: smaStopHit ? 'SMA50_TRAIL_STOP' : 'ADX_FADE',
        entryPrice, entryTimestamp, exitPrice, exitTimestamp, holdingPeriodDays, actualReturn,
        outcome: actualReturn > 0 ? 'WIN' : actualReturn < 0 ? 'LOSS' : 'N_A',
        finalPrice: exitPrice,
      };
    }
  }

  // Never forced into WIN/LOSS - the position simply had not been stopped out within the window.
  const lastBar = bars[bars.length - 1];
  const unrealizedRaw = (lastBar.close - entryPrice) / entryPrice;
  const holdingPeriodDays = Math.round((lastBar.timestamp - bars[entryIdx].timestamp) / (24 * 60 * 60 * 1000));
  return {
    exitReason: 'STILL_OPEN',
    entryPrice, entryTimestamp,
    exitPrice: null, exitTimestamp: null,
    holdingPeriodDays,
    actualReturn: isLong ? unrealizedRaw : -unrealizedRaw,
    outcome: 'STILL_OPEN',
    finalPrice: lastBar.close,
  };
}
