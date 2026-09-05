package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.MovingAverages;

import java.util.Arrays;

/**
 * Classical fast/slow moving-average crossover (golden/death cross family), built on the
 * existing MovingAverages indicator (SMA/EMA) rather than a new moving-average implementation -
 * single authoritative path per the Java Quant Core Authority policy.
 */
public final class MovingAverageCrossoverEngine {

    private MovingAverageCrossoverEngine() {
    }

    public enum MaType { SMA, EMA }

    public record Result(
        double fastValue,
        double slowValue,
        double previousFastValue,
        double previousSlowValue,
        boolean bullishCross,
        boolean bearishCross,
        boolean fastAboveSlow
    ) {
    }

    /**
     * @param closes   chronological close prices.
     * @param fastPeriod e.g. 20.
     * @param slowPeriod e.g. 50. Must be > fastPeriod.
     * @param type     SMA or EMA.
     * @return null if there isn't enough data for both periods plus one prior bar to detect a cross.
     */
    public static Result evaluate(double[] closes, int fastPeriod, int slowPeriod, MaType type) {
        int n = closes.length;
        if (fastPeriod < 1 || slowPeriod <= fastPeriod || n <= slowPeriod + 1) {
            return null;
        }
        double[] priorCloses = Arrays.copyOfRange(closes, 0, n - 1);

        double fast, slow, priorFast, priorSlow;
        if (type == MaType.EMA) {
            double[] fastEma = MovingAverages.ema(closes, fastPeriod);
            double[] slowEma = MovingAverages.ema(closes, slowPeriod);
            fast = fastEma[fastEma.length - 1];
            slow = slowEma[slowEma.length - 1];
            priorFast = fastEma[fastEma.length - 2];
            priorSlow = slowEma[slowEma.length - 2];
        } else {
            fast = MovingAverages.sma(closes, fastPeriod);
            slow = MovingAverages.sma(closes, slowPeriod);
            priorFast = MovingAverages.sma(priorCloses, fastPeriod);
            priorSlow = MovingAverages.sma(priorCloses, slowPeriod);
        }

        boolean bullishCross = priorFast <= priorSlow && fast > slow;
        boolean bearishCross = priorFast >= priorSlow && fast < slow;

        return new Result(fast, slow, priorFast, priorSlow, bullishCross, bearishCross, fast > slow);
    }
}
