package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.MACD;

/**
 * Classical MACD signal-line crossover (Gerald Appel's original public-domain definition): a
 * bullish signal when the MACD line crosses above its own EMA-smoothed signal line, bearish when
 * it crosses below. Built on the existing MACD indicator (already ported byte-for-byte from
 * src/server/engines/MACDEngine.ts) rather than a new implementation - single authoritative path
 * per the Java Quant Core Authority policy. Detects the actual cross (previous vs current
 * relationship), not just the current sign of the histogram, matching
 * MovingAverageCrossoverEngine.java's own cross-detection convention. EXPERIMENTAL/RESEARCH
 * status: real formula, zero live consumer, no claim of validated edge.
 */
public final class MacdCrossoverEngine {

    private MacdCrossoverEngine() {
    }

    public record Result(
        double macd,
        double signal,
        double histogram,
        double previousMacd,
        double previousSignal,
        boolean bullishCross,
        boolean bearishCross
    ) {
    }

    /**
     * @param closes       chronological close prices.
     * @param shortPeriod  fast EMA period, e.g. 12.
     * @param longPeriod   slow EMA period, e.g. 26. Must be &gt; shortPeriod.
     * @param signalPeriod signal-line EMA period, e.g. 9.
     * @return null if there isn't enough data for the long EMA plus one prior bar to detect a cross.
     */
    public static Result evaluate(double[] closes, int shortPeriod, int longPeriod, int signalPeriod) {
        int n = closes.length;
        if (shortPeriod < 1 || longPeriod <= shortPeriod || signalPeriod < 1 || n <= longPeriod + 1) {
            return null;
        }

        MACD macd = new MACD(shortPeriod, longPeriod, signalPeriod);
        double[] priorCloses = java.util.Arrays.copyOfRange(closes, 0, n - 1);

        MACD.Result current = macd.calculate(closes);
        MACD.Result prior = macd.calculate(priorCloses);

        boolean bullishCross = prior.macd() <= prior.signal() && current.macd() > current.signal();
        boolean bearishCross = prior.macd() >= prior.signal() && current.macd() < current.signal();

        return new Result(current.macd(), current.signal(), current.histogram(),
            prior.macd(), prior.signal(), bullishCross, bearishCross);
    }

    /** Appel's own conventional 12/26/9 defaults. */
    public static Result evaluate(double[] closes) {
        return evaluate(closes, 12, 26, 9);
    }
}
