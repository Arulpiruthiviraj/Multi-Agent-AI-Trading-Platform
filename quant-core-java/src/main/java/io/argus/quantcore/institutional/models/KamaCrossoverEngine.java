package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.Kama;
import io.argus.quantcore.indicators.MovingAverages;

/**
 * The "Two-Average" / golden-cross / dead-cross strategy (Jun Lu, "Exploring Classic
 * Quantitative Strategies", arXiv:2202.11309, 2022, Section 2.4), applied with Kaufman's
 * Adaptive Moving Average (see Kama.java) as the fast/adaptive line against a slower reference
 * SMA - the paper's own general framing ("have two sets of MAs: one longer and one shorter...
 * when the shorter-term MA crosses above the longer-term MA, it's a buy signal ('golden cross');
 * when it crosses below, a sell signal ('dead/death cross')") applied to the specific adaptive-MA
 * case it spends most of the paper building up to. RESEARCH status: real formula, zero live
 * consumer, no claim of validated edge - the paper itself explicitly warns MA crossovers whipsaw
 * in choppy/ranging conditions.
 */
public final class KamaCrossoverEngine {

    private KamaCrossoverEngine() {
    }

    public record Result(
        double kama,
        double referenceSma,
        double previousKama,
        double previousReferenceSma,
        String crossSignal // BUY (golden cross), SELL (dead cross), NEUTRAL (no cross this bar)
    ) {
    }

    /**
     * @param closes         chronological close prices.
     * @param referencePeriod period of the slower reference SMA the KAMA line is compared against.
     * @param adaWin         Kaufman efficiency-ratio window for the KAMA line.
     * @param fastPeriod     KAMA's fast EMA-equivalent period.
     * @param slowPeriod     KAMA's slow EMA-equivalent period.
     * @return null if there isn't enough history to detect a cross (needs at least 2 bars past
     *         the reference SMA's own period).
     */
    public static Result evaluate(double[] closes, int referencePeriod, int adaWin, int fastPeriod, int slowPeriod) {
        if (closes == null || closes.length < referencePeriod + 2) {
            return null;
        }
        double[] kamaSeries = Kama.calculate(closes, adaWin, fastPeriod, slowPeriod);
        int last = closes.length - 1;

        double kamaNow = kamaSeries[last];
        double kamaPrev = kamaSeries[last - 1];
        double smaNow = MovingAverages.sma(java.util.Arrays.copyOfRange(closes, 0, last + 1), referencePeriod);
        double smaPrev = MovingAverages.sma(java.util.Arrays.copyOfRange(closes, 0, last), referencePeriod);

        boolean goldenCross = kamaPrev <= smaPrev && kamaNow > smaNow;
        boolean deadCross = kamaPrev >= smaPrev && kamaNow < smaNow;
        String signal = goldenCross ? "BUY" : deadCross ? "SELL" : "NEUTRAL";

        return new Result(kamaNow, smaNow, kamaPrev, smaPrev, signal);
    }

    /** Paper's own worked-example defaults: AdaWin=12, fast=5, slow=50; reference SMA period=50 to match. */
    public static Result evaluate(double[] closes) {
        return evaluate(closes, 50, 12, 5, 50);
    }
}
