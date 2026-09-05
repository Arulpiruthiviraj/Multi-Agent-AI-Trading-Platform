package io.argus.quantcore.features;

import io.argus.quantcore.indicators.MovingAverages;
import io.argus.quantcore.indicators.Volatility;

/**
 * Small set of src/server/engines/TechnicalIndicators.ts-compatible primitives that JMIG-001's
 * feature computations (trend.ts/volatility.ts/volume.ts/supportResistance.ts) need, that the
 * existing io.argus.quantcore.indicators classes either don't provide or (for EMA) implement
 * differently on purpose for a DIFFERENT TS caller:
 *
 * <ul>
 *   <li>{@link #sma} reuses {@link MovingAverages#sma} directly - verified byte-identical to
 *       TechnicalIndicators.ts's {@code calculateSMA} (same "return last price if too short"
 *       fallback, same trailing-window average) - not a second SMA implementation.</li>
 *   <li>{@link #ema} is NEW: {@link MovingAverages#ema} mirrors MACDEngine.ts's private
 *       {@code calcEMA} (seeds with the raw first price, iterates every bar, returns the full
 *       series) for its own CORE-strategy callers. TechnicalIndicators.ts's {@code calculateEMA}
 *       is a genuinely different algorithm - seeds with an SMA(period) over the FIRST {@code
 *       period} values, iterates starting at index {@code period}, returns only the final value,
 *       and falls back to the last price when there isn't a full period of history yet. trend.ts's
 *       {@code movingAverageSet()} and volatility.ts's {@code keltnerChannels()} call THIS one, so
 *       it is ported here rather than reusing {@link MovingAverages#ema} (which would silently
 *       produce the wrong number for this migration item).</li>
 *   <li>{@link #atr} reuses {@link Volatility#atr} directly - already ported byte-for-byte from
 *       the same TechnicalIndicators.ts {@code calculateATR} that this migration item's
 *       volatility.ts also wraps. Not a second ATR implementation.</li>
 *   <li>{@link #bollingerBands} is NEW: mirrors TechnicalIndicators.ts's {@code
 *       calculateBollingerBands} exactly (population variance divided by {@code period}, same
 *       "flat last price" fallback below {@code period} bars) - distinct from the existing
 *       {@code io.argus.quantcore.indicators.Bollinger}, which ports technicalSignal.ts's
 *       {@code calcBollingerBands} (a different, unrelated TS function) for the CORE strategies'
 *       own indicator needs.</li>
 *   <li>{@link #obv}, {@link #mfi}, {@link #vwap}, {@link #fibonacciRetracement} port
 *       TechnicalIndicators.ts's {@code calculateOBV}/{@code calculateMFI}/{@code calculateVWAP}/
 *       {@code calculateFibonacciRetracement} respectively - none had a prior Java port anywhere
 *       in this module.</li>
 * </ul>
 */
public final class TechnicalIndicatorsCompat {
    private TechnicalIndicatorsCompat() {
    }

    /** Matches calculateSMA exactly (delegates to the already-verified-identical MovingAverages.sma). */
    public static double sma(double[] prices, int period) {
        return MovingAverages.sma(prices, period);
    }

    /** Matches TechnicalIndicators.ts's calculateEMA exactly: SMA(period)-seeded, single final value. */
    public static double ema(double[] prices, int period) {
        if (prices.length < period) {
            return prices.length == 0 ? 0 : prices[prices.length - 1];
        }
        double[] seed = new double[period];
        System.arraycopy(prices, 0, seed, 0, period);
        double emaVal = MovingAverages.sma(seed, period);
        double multiplier = 2.0 / (period + 1);
        for (int i = period; i < prices.length; i++) {
            emaVal = (prices[i] - emaVal) * multiplier + emaVal;
        }
        return emaVal;
    }

    /** Matches calculateATR exactly (delegates to the already-verified-identical Volatility.atr). */
    public static double atr(double[] highs, double[] lows, double[] closes, int period) {
        return Volatility.atr(highs, lows, closes, period);
    }

    public record BollingerBands(double middle, double upper, double lower) {
    }

    /** Matches TechnicalIndicators.ts's calculateBollingerBands exactly (population variance). */
    public static BollingerBands bollingerBands(double[] prices, int period, double stdDevMultiplier) {
        if (prices.length < period) {
            double last = prices.length == 0 ? 0 : prices[prices.length - 1];
            return new BollingerBands(last, last, last);
        }
        double sma = MovingAverages.sma(prices, period);
        double sumSq = 0;
        for (int i = prices.length - period; i < prices.length; i++) {
            double d = prices[i] - sma;
            sumSq += d * d;
        }
        double sd = Math.sqrt(sumSq / period);
        return new BollingerBands(sma, sma + sd * stdDevMultiplier, sma - sd * stdDevMultiplier);
    }

    /** Matches TechnicalIndicators.ts's calculateOBV exactly. */
    public static double obv(double[] closes, double[] volumes) {
        if (closes.length == 0) {
            return 0;
        }
        double obv = 0;
        for (int i = 1; i < closes.length; i++) {
            if (closes[i] > closes[i - 1]) {
                obv += volumes[i];
            } else if (closes[i] < closes[i - 1]) {
                obv -= volumes[i];
            }
        }
        return obv;
    }

    /** Matches TechnicalIndicators.ts's calculateMFI exactly. */
    public static double mfi(double[] highs, double[] lows, double[] closes, double[] volumes, int period) {
        if (closes.length < period + 1) {
            return 50;
        }
        double positive = 0;
        double negative = 0;
        for (int i = closes.length - period; i < closes.length; i++) {
            double typicalPrice = (highs[i] + lows[i] + closes[i]) / 3.0;
            double prevTypicalPrice = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3.0;
            double moneyFlow = typicalPrice * volumes[i];
            if (typicalPrice > prevTypicalPrice) {
                positive += moneyFlow;
            } else if (typicalPrice < prevTypicalPrice) {
                negative += moneyFlow;
            }
        }
        if (negative == 0) {
            return 100;
        }
        double moneyRatio = positive / negative;
        return 100 - (100 / (1 + moneyRatio));
    }

    /** Matches TechnicalIndicators.ts's calculateVWAP exactly (cumulative, not session-anchored -
     *  volume.ts's own calculateSessionVWAP supplies the session-filtered arrays before calling this). */
    public static double vwap(double[] prices, double[] volumes) {
        if (prices.length == 0) {
            return 0;
        }
        double sumPV = 0;
        double sumV = 0;
        for (int i = 0; i < prices.length; i++) {
            sumPV += prices[i] * volumes[i];
            sumV += volumes[i];
        }
        return sumV == 0 ? prices[prices.length - 1] : sumPV / sumV;
    }

    public record Fibonacci(double level0, double level236, double level382, double level500,
                             double level618, double level786, double level100) {
    }

    /** Matches TechnicalIndicators.ts's calculateFibonacciRetracement exactly. */
    public static Fibonacci fibonacciRetracement(double high, double low) {
        double diff = high - low;
        return new Fibonacci(low, low + diff * 0.236, low + diff * 0.382, low + diff * 0.5,
            low + diff * 0.618, low + diff * 0.786, high);
    }
}
