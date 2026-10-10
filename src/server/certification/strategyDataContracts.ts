/**
 * ==========================================================
 * Module: certification/strategyDataContracts
 *
 * Purpose (Phase 4 of the pre-market certification platform):
 * A machine-readable data contract for every TS strategy. The Oct-9 audit found strategies
 * evaluated on daily bars while needing intraday inputs (e.g. OPENING_RANGE_BREAKOUT requires
 * an opening range that daily bars cannot produce; VWAP strategies need a genuine session VWAP
 * from intraday bars). The strategies already fail closed individually via `available`/`reason`
 * flags (supportResistance.openingRange, volume.vwap.intradayBased), but nothing declared each
 * strategy's data requirements in one machine-readable place, and no readiness check reported
 * per-strategy DATA_READY / PARTIALLY_READY / NOT_READY. This registry is that place.
 *
 * This file declares data requirements only. It changes no strategy, no threshold, no formula,
 * no gate - it is certification-plane metadata. New files under src/server/certification/ only.
 *
 * Contract semantics per dimension:
 *   REQUIRED   - without this input the strategy's DEFINING setup/trigger is structurally
 *                impossible, or the strategy's own documented design treats the input as
 *                essential (explicit fail-closed statement in the strategy). Missing a
 *                REQUIRED input => NOT_READY: the strategy must not be considered operational
 *                on this bar set, never silently.
 *   OPTIONAL   - read only as a confirming condition that fails honestly (fails closed, stated
 *                in conditionsFailed) when the input is missing; the trigger can still fire.
 *                Missing OPTIONAL inputs => PARTIALLY_READY (degraded score, still honest).
 *   NOT_NEEDED - evaluate() never reads this input family.
 *
 * minDailyBars: the minimum daily-bar history the strategy's own reads need. Grounded in each
 * strategy's indicators (SMA200 => 200, RVOL period 20 => 21, Donchian prior lookback 20 =>
 * 21 excluding the current bar, etc.). Below it, the contract reports NOT_READY with
 * 'minDailyBars' listed as the missing required input.
 *
 * QUANT_RESEARCH_REQUIRED findings (do NOT fix strategies from here - recorded only):
 *   QR-1 RANGE_REVERSAL (rangeReversion.ts): `check('No real volume spike ...',
 *        volume.isSpike !== true)`. isSpike is `boolean | null`; when RVOL is unavailable
 *        (fewer than 21 bars) isSpike is null and `null !== true` is true, so the "no spike"
 *        confirming condition PASSES with no spike measurement at all - missing data is
 *        silently treated as fine. Confirming condition only (trigger requires a real range
 *        boundary), but the contract cannot distinguish "measured no spike" from "no data".
 *   QR-2 VOLUME_CONFIRMATION (volumeConfirmation.ts): `const bullish =
 *        (volume.cmf ?? 0) >= 0 && ...`. A null CMF coerces to 0, which is >= 0, so side
 *        selection defaults to BUY with no CMF evidence. The CMF check itself fails closed
 *        and triggerMet requires a real volume spike, so this is a direction-bias on missing
 *        data, not a silent emission - still research-worthy.
 * ==========================================================
 */

/** Availability level of one data-input family for a strategy. */
export type DataRequirement = 'REQUIRED' | 'OPTIONAL' | 'NOT_NEEDED';

/** The machine-readable data contract for one strategy. */
export interface DataContract {
  /** Fine-grained (e.g. 1-minute) bars of the current session. */
  intradayBars: DataRequirement;
  /** Genuine intraday-based session VWAP (volume.vwap with intradayBased=true). A "session
   *  VWAP" built from daily bars degenerates to today's single-bar typical price - strategies
   *  that need a real anchor must treat that as absent (see indicators/volume.ts). */
  sessionVWAP: DataRequirement;
  /** Prior-day OHLC levels (supportResistance.previousDay: PDH/PDL). */
  priorDayLevels: DataRequirement;
  /** Relative volume family (volume.relativeVolume / volume.isSpike, period 20). */
  rvol: DataRequirement;
  /** Sector regime from MarketContext (sector trend via sector ETF). */
  sectorData: DataRequirement;
  /** Stock-vs-SPY relative strength (marketContext.relativeStrengthVsSPY). */
  relativeStrengthVsSpy: DataRequirement;
  /** Minimum daily-bar history the strategy's own indicator reads need. */
  minDailyBars: number;
}

/**
 * The registry: one contract per strategy id, keyed by the strategy's own id string.
 * Every entry carries an evidence comment citing exactly what evaluate() reads and how it
 * fails closed (or doesn't) when the input is missing.
 */
export const STRATEGY_DATA_CONTRACTS: Record<string, DataContract> = {
  // MOMENTUM_BREAKOUT (momentumBreakout.ts)
  // - sessionVWAP OPTIONAL: "Price above/below session VWAP" check (line ~59) requires
  //   volume.vwap.intradayBased and fails closed (condition fails, never throws) when the
  //   VWAP is not genuinely intraday-based; trigger is the structural BOS break, independent.
  // - intradayBars OPTIONAL: only feed the VWAP condition above; every other read
  //   (trend.structure, RSI/ROC, ATR, sector, RS vs SPY) is daily-bar-appropriate.
  // - rvol OPTIONAL: "RVOL confirmation" check fails closed when volume.relativeVolume is null.
  // - sectorData OPTIONAL: marketContext.sector.trend read with explicit null/undefined guards.
  // - relativeStrengthVsSpy OPTIONAL: relativeStrengthPct read with null guards, condition fails
  //   closed when absent.
  // - priorDayLevels NOT_NEEDED: previousDay never read directly.
  // - minDailyBars 20: RSI(14)/ROC(12)/ATR(14)/DMI(14) plus swing-structure BOS detection.
  MOMENTUM_BREAKOUT: {
    intradayBars: 'OPTIONAL',
    sessionVWAP: 'OPTIONAL',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'OPTIONAL',
    relativeStrengthVsSpy: 'OPTIONAL',
    minDailyBars: 20,
  },

  // PULLBACK_CONTINUATION (pullbackContinuation.ts)
  // - rvol OPTIONAL: "Volume contracted during the pullback" check requires
  //   volume.relativeVolume !== null; trigger is the established trend itself.
  // - Everything else NOT_NEEDED: reads trend.structure/SMA20, RSI, candlestick, regime only.
  // - minDailyBars 20: priceVsSMA20 and SMA20 stop need 20 bars.
  PULLBACK_CONTINUATION: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 20,
  },

  // MEAN_REVERSION (meanReversion.ts)
  // - All input families NOT_NEEDED: reads RSI/stochasticRSI, Keltner channels, candlestick,
  //   nearest S/R, regime only. No volume, VWAP, or market-context reads.
  // - minDailyBars 20: Keltner EMA(20)/ATR(10); stochasticRSI(14,14).
  MEAN_REVERSION: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'NOT_NEEDED',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 20,
  },

  // TREND_FOLLOWING (trendFollowing.ts)
  // - All input families NOT_NEEDED: reads moving averages (SMA20/50/200), DMI/ADX, MACD, CMF,
  //   regime only. CMF check fails closed when volume.cmf is null.
  // - minDailyBars 200: the MA-stack check requires non-null SMA200.
  TREND_FOLLOWING: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'NOT_NEEDED',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 200,
  },

  // RANGE_REVERSION (rangeReversion.ts)
  // - rvol OPTIONAL: reads volume.isSpike ("No real volume spike" check) - the spike flag is
  //   built directly on relativeVolume (indicators/volume.ts isVolumeSpike).
  //   QUANT_RESEARCH_REQUIRED (QR-1): `volume.isSpike !== true` passes when isSpike is null
  //   (unavailable), so missing spike data is silently treated as "no spike". Confirming
  //   condition only; trigger requires a real range boundary.
  // - Everything else NOT_NEEDED: reads S/R levels, RSI, market structure, regime.
  // - minDailyBars 10: swing-based S/R detection (lookback 2); previousDay needs 2.
  RANGE_REVERSION: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 10,
  },

  // SMC_LIQUIDITY_SWEEP (smcLiquiditySweep.ts)
  // - rvol OPTIONAL: "Volume confirmation (RVOL >= ...)" check fails closed when
  //   volume.relativeVolume is null.
  // - smc itself: ctx.smc is validated field-by-field; a missing/partial shape fails closed
  //   to emptySmc() and triggerMet (sweep + CHoCH) can never fire on it.
  // - Everything else NOT_NEEDED: no VWAP, intraday, prior-day, sector, or RS reads.
  // - minDailyBars 20: SMC swing/structure/displacement detection over the bar series.
  SMC_LIQUIDITY_SWEEP: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 20,
  },

  // VWAP_VOLUME_STRUCTURE (vwapVolumeStructure.ts)
  // - sessionVWAP REQUIRED: distance is forced to null unless vwapInfo.intradayBased
  //   (line ~39); the strategy pushes an explicit contradiction - "No genuine session VWAP
  //   (real intraday bars required) - the VWAP anchor is not real on this bar set" - when
  //   the anchor is absent. VWAP is the strategy's namesake anchor, not an incidental check.
  // - intradayBars REQUIRED: genuine intradayBased VWAP can only be computed from real
  //   intraday bars (computeVolumeFeatures' intradayBars path, indicators/volume.ts).
  // - rvol OPTIONAL: "RVOL confirmation" check fails closed when relativeVolume is null.
  // - minDailyBars 20: trend structure + DMI/ADX(14).
  VWAP_VOLUME_STRUCTURE: {
    intradayBars: 'REQUIRED',
    sessionVWAP: 'REQUIRED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 20,
  },

  // OPENING_RANGE_BREAKOUT (openingRangeBreakout.ts)
  // - intradayBars REQUIRED: triggerMet requires supportResistance.openingRange.available,
  //   which is false on daily bars - "daily bars cannot produce an ORB" (explicit
  //   contradiction). The strategy never fabricates an opening range from a daily candle.
  // - sessionVWAP REQUIRED: "Price above/below session VWAP" is part of the documented setup
  //   ("close beyond the session opening-range high/low with RVOL and VWAP alignment") and
  //   the check explicitly requires volume.vwap.intradayBased - a daily-bar VWAP can never
  //   satisfy it, so the full setup is unproducible without genuine session VWAP.
  // - priorDayLevels OPTIONAL: "Prior-day high/low available as range context" check fails
  //   closed when supportResistance.previousDay is null; trigger independent of it.
  // - rvol OPTIONAL: "RVOL confirmation" check fails closed when relativeVolume is null.
  // - minDailyBars 15: ATR(14) for stops/targets; previousDay needs 2.
  OPENING_RANGE_BREAKOUT: {
    intradayBars: 'REQUIRED',
    sessionVWAP: 'REQUIRED',
    priorDayLevels: 'OPTIONAL',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 15,
  },

  // VWAP_MEAN_REVERSION (vwapMeanReversion.ts)
  // - sessionVWAP REQUIRED: triggerMet = genuineVwap && (extendedDown || extendedUp), where
  //   genuineVwap requires volume.vwap.intradayBased (line ~31). Without genuine session
  //   VWAP "there is no anchor" - the trigger is structurally impossible. The file states:
  //   "the extension read is only real with genuine intraday session VWAP."
  // - intradayBars REQUIRED: same reasoning as VWAP_VOLUME_STRUCTURE - genuine session VWAP
  //   comes only from the intradayBars path of computeVolumeFeatures.
  // - rvol OPTIONAL: "Volume not a trend-day expansion (RVOL < ...)" check fails closed when
  //   relativeVolume is null.
  // - minDailyBars 20: DMI/ADX(14) range-ceiling check.
  VWAP_MEAN_REVERSION: {
    intradayBars: 'REQUIRED',
    sessionVWAP: 'REQUIRED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 20,
  },

  // DONCHIAN_CHANNEL_BREAKOUT (donchianBreakout.ts)
  // - rvol OPTIONAL: "RVOL confirmation" check fails closed when relativeVolume is null.
  // - The prior-channel check fails closed (channel === null => condition fails plus an
  //   explicit contradiction "not enough bars excluding the current print"); triggerMet
  //   requires an actual break, impossible without the channel.
  // - Everything else NOT_NEEDED: no VWAP, intraday, prior-day, sector, or RS reads.
  // - minDailyBars 21: donchianPriorLookback = 20 (config/quantExperimentalStrategies.json)
  //   prior bars excluding the current bar, plus the current bar itself.
  DONCHIAN_CHANNEL_BREAKOUT: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 21,
  },

  // MA_CROSSOVER (maCrossover.ts)
  // - All input families NOT_NEEDED: reads movingAverages (SMA50/SMA200/EMA9/EMA20), DMI/ADX,
  //   regime, ATR. Null movingAverages fails closed ("not a fabricated crossover").
  // - minDailyBars 200: the golden/death-cross stack requires non-null SMA200.
  MA_CROSSOVER: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'NOT_NEEDED',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 200,
  },

  // OSCILLATOR_MOMENTUM (oscillatorMomentum.ts)
  // - All input families NOT_NEEDED: reads RSI, MACD histogram, ROC, DMI, regime, ATR.
  //   triggerMet requires macd !== null ("Null MACD never triggers").
  // - minDailyBars 30: MACD(12,26,9) via MACDEngine needs 26 bars minimum for the slow EMA
  //   plus signal-line warmup; 30 is the conservative floor.
  OSCILLATOR_MOMENTUM: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'NOT_NEEDED',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 30,
  },

  // BOLLINGER_VOLATILITY (bollingerVolatility.ts)
  // - rvol OPTIONAL: "RVOL confirmation" check fails closed when relativeVolume is null.
  // - Everything else NOT_NEEDED: reads Keltner channels, volatility regime, Bollinger width,
  //   ADX, consolidation flag. No VWAP, intraday, prior-day, sector, or RS reads.
  // - minDailyBars 21: Keltner EMA(20)/ATR(10); RVOL needs period 20 + 1 bar.
  BOLLINGER_VOLATILITY: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 21,
  },

  // PREVIOUS_PERIOD_BREAKOUT (previousPeriodBreakout.ts)
  // - priorDayLevels REQUIRED: triggerMet requires brokeHigh/brokeLow, which require
  //   supportResistance.previousDay !== null; the check "Previous-day high/low available"
  //   fails closed and an explicit contradiction ("No completed prior UTC day in the bar
  //   set - not a fabricated PDH/PDL") is pushed. The setup is structurally impossible
  //   without prior-day levels.
  // - rvol OPTIONAL: "RVOL confirmation" check fails closed when relativeVolume is null.
  // - Everything else NOT_NEEDED.
  // - minDailyBars 2: one completed prior UTC day plus the current bar.
  PREVIOUS_PERIOD_BREAKOUT: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'REQUIRED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 2,
  },

  // CANDLESTICK_REVERSAL (candlestickReversal.ts)
  // - All input families NOT_NEEDED: reads priceAction.candlestick, nearest S/R, RSI, ATR.
  //   triggerMet requires a detected pattern AND proximity to a real level ("no pattern,
  //   no reversal"). RSI is typed `number` (RSIEngine returns neutral 50 when data is
  //   insufficient), so the RSI comparisons cannot misfire on missing data.
  // - minDailyBars 15: RSI(14); 1-2 bar candlestick patterns need only a few bars.
  CANDLESTICK_REVERSAL: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'NOT_NEEDED',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 15,
  },

  // GAP_CONTINUATION (gapContinuation.ts)
  // - sessionVWAP OPTIONAL: "Price above/below session VWAP" check requires
  //   volume.vwap.intradayBased and fails closed when absent; trigger is the gap itself.
  // - rvol OPTIONAL: "RVOL confirmation" check fails closed when relativeVolume is null.
  // - priorDayLevels NOT_NEEDED: the gap read comes from priceAction.gap (bar-series
  //   based), not from supportResistance.previousDay.
  // - minDailyBars 15: gap needs a prior close (2 bars); ATR(14) for stop/target.
  GAP_CONTINUATION: {
    intradayBars: 'OPTIONAL',
    sessionVWAP: 'OPTIONAL',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 15,
  },

  // FIBONACCI_PULLBACK (fibonacciPullback.ts)
  // - rvol OPTIONAL: "Volume not exploding (RVOL < breakout threshold)" check fails closed
  //   when relativeVolume is null.
  // - Everything else NOT_NEEDED: reads supportResistance.fibonacci (trailing daily range),
  //   trend structure, RSI, regime. fib === null pushes an explicit contradiction ("No
  //   daily-range Fibonacci - not a fabricated ... confluence stack") and triggerMet
  //   requires near618, impossible without the fib level.
  // - minDailyBars 15: trailing daily-range fib + RSI(14).
  FIBONACCI_PULLBACK: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 15,
  },

  // VOLUME_CONFIRMATION (volumeConfirmation.ts)
  // - rvol REQUIRED: the volume spike IS this setup - triggerMet requires
  //   volume.isSpike === true OR relativeVolume >= threshold, and both are false when the
  //   data is missing (isSpike is `boolean | null`; relativeVolume null-gated). Without
  //   RVOL data the strategy can never trigger: fails closed by construction.
  //   QUANT_RESEARCH_REQUIRED (QR-2): side selection does `(volume.cmf ?? 0) >= 0`, so a
  //   null CMF coerces to 0 and biases direction to BUY without CMF evidence. The CMF
  //   check itself fails closed and triggerMet needs a real spike, so this is a
  //   direction-bias on missing data, not a silent emission.
  // - Everything else NOT_NEEDED: reads CMF, MFI, market structure, regime.
  // - minDailyBars 21: RVOL needs period 20 + 1 bar; CMF(20).
  VOLUME_CONFIRMATION: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'REQUIRED',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 21,
  },

  // SR_BOUNCE (srBounce.ts)
  // - rvol OPTIONAL: "Not a volume-spike breakout (RVOL below breakout threshold)" check
  //   fails closed when relativeVolume is null.
  // - Everything else NOT_NEEDED: reads nearest S/R, candlestick, regime, ATR.
  // - minDailyBars 10: swing-based S/R detection (lookback 2).
  SR_BOUNCE: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'OPTIONAL',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 10,
  },

  // RELATIVE_STRENGTH_ROTATION (relativeStrengthRotation.ts)
  // - relativeStrengthVsSpy REQUIRED: triggerMet requires rsNum !== null; side selection
  //   explicitly "never defaults bullish on missing data" (a null RS previously coerced to
  //   0 and the strategy emitted BUY ideas with its namesake input absent - fixed, and the
  //   fail-closed behavior is asserted in code). Without the RS input there is "nothing
  //   to rotate on".
  // - sectorData OPTIONAL: "Favorable sector regime when a sector ETF trend exists" check
  //   fails closed when marketContext.sector.trend is null/undefined.
  // - Everything else NOT_NEEDED: no volume, VWAP, intraday, or prior-day reads.
  // - minDailyBars 200: the "Bullish/Bearish daily stack (price > SMA50 > SMA200)" check
  //   requires non-null SMA200.
  RELATIVE_STRENGTH_ROTATION: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'NOT_NEEDED',
    sectorData: 'OPTIONAL',
    relativeStrengthVsSpy: 'REQUIRED',
    minDailyBars: 200,
  },

  // STATISTICAL_MEAN_REVERSION (statisticalMeanReversion.ts)
  // - All input families NOT_NEEDED: reads closePriceZScore, RSI, Keltner middle, ADX,
  //   regime. triggerMet requires an actual z-score extreme (stretchedDown/stretchedUp),
  //   both null-gated. A missing Keltner middle yields a null target, never a zero-distance
  //   target at the entry price (fixed in-strategy).
  // - minDailyBars 20: closePriceZScoreLookback = 20 (config/quantExperimentalStrategies.json).
  STATISTICAL_MEAN_REVERSION: {
    intradayBars: 'NOT_NEEDED',
    sessionVWAP: 'NOT_NEEDED',
    priorDayLevels: 'NOT_NEEDED',
    rvol: 'NOT_NEEDED',
    sectorData: 'NOT_NEEDED',
    relativeStrengthVsSpy: 'NOT_NEEDED',
    minDailyBars: 20,
  },
};

/** Look up a strategy's data contract by its strategy id. Returns undefined for unknown ids. */
export function getDataContract(strategyId: string): DataContract | undefined {
  return STRATEGY_DATA_CONTRACTS[strategyId];
}

/** A description of the data actually available for one evaluation cycle, in the same
 *  vocabulary the contracts use. */
export interface AvailableData {
  /** Fine-grained (e.g. 1-minute) bars of the current session are present. */
  intradayBars: boolean;
  /** Number of daily bars available for indicator computation. */
  dailyBars: number;
  /** A genuine intraday-based session VWAP is present (vwap.intradayBased === true). */
  sessionVWAP: boolean;
  /** Prior-day OHLC levels (supportResistance.previousDay) are present. */
  priorDayLevels: boolean;
  /** The RVOL family (relativeVolume / isSpike) is computable. */
  rvol: boolean;
  /** Sector regime data (marketContext.sector.trend) is present. */
  sectorData: boolean;
  /** Stock-vs-SPY relative strength is present. */
  relativeStrengthVsSpy: boolean;
}

/** Per-strategy readiness verdict. */
export type DataReadiness = 'DATA_READY' | 'PARTIALLY_READY' | 'NOT_READY';

/** Readiness verdict for one strategy, with the exact missing inputs stated openly. */
export interface StrategyDataReadiness {
  strategyId: string;
  readiness: DataReadiness;
  /** Contract dimensions marked REQUIRED that are not available. Non-empty => NOT_READY. */
  missingRequired: string[];
  /** Contract dimensions marked OPTIONAL that are not available. Non-empty (with no required
   *  gaps) => PARTIALLY_READY. */
  missingOptional: string[];
}

/**
 * Evaluate per-strategy data readiness against the contracts. Pure function - no I/O.
 *
 * Rules:
 *  - every REQUIRED dimension that is unavailable lands in missingRequired;
 *  - dailyBars < contract.minDailyBars lands in missingRequired as 'minDailyBars';
 *  - OPTIONAL dimensions unavailable land in missingOptional;
 *  - NOT_READY if any required input is missing, else PARTIALLY_READY if any optional
 *    input is missing, else DATA_READY.
 *
 * A strategy that is NOT_READY must never be treated as operational on this bar set -
 * its trigger is structurally impossible or its namesake input is absent.
 */
export function evaluateDataReadiness(available: AvailableData): StrategyDataReadiness[] {
  const dimensionValue: Record<Exclude<keyof DataContract, 'minDailyBars'>, (a: AvailableData) => boolean> = {
    intradayBars: a => a.intradayBars,
    sessionVWAP: a => a.sessionVWAP,
    priorDayLevels: a => a.priorDayLevels,
    rvol: a => a.rvol,
    sectorData: a => a.sectorData,
    relativeStrengthVsSpy: a => a.relativeStrengthVsSpy,
  };

  return Object.entries(STRATEGY_DATA_CONTRACTS).map(([strategyId, contract]) => {
    const missingRequired: string[] = [];
    const missingOptional: string[] = [];

    for (const [dimension, isAvailable] of Object.entries(dimensionValue) as Array<
      [keyof typeof dimensionValue, (a: AvailableData) => boolean]
    >) {
      const level = contract[dimension];
      if (level === 'NOT_NEEDED') continue;
      if (!isAvailable(available)) {
        (level === 'REQUIRED' ? missingRequired : missingOptional).push(dimension);
      }
    }

    if (available.dailyBars < contract.minDailyBars) {
      missingRequired.push('minDailyBars');
    }

    const readiness: DataReadiness =
      missingRequired.length > 0 ? 'NOT_READY' : missingOptional.length > 0 ? 'PARTIALLY_READY' : 'DATA_READY';

    return { strategyId, readiness, missingRequired, missingOptional };
  });
}
