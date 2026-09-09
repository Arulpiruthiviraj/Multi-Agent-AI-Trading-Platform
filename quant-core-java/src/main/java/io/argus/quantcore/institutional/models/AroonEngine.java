package io.argus.quantcore.institutional.models;

/**
 * Aroon indicator and unconditioned crossover strategy. Tushar S. Chande's public-domain
 * indicator (Technical Analysis of Stocks &amp; Commodities, Sept. 1995). Formula transcribed
 * from Jun Lu, "Exploring Classic Quantitative Strategies" (arXiv:2202.11309, 2022), Eq. (5.1):
 *   AroonUp   = 100 * (N - periodsSinceHighestHigh) / N
 *   AroonDown = 100 * (N - periodsSinceLowestLow)   / N
 *   AroonOscillator = AroonUp - AroonDown
 *
 * Strategy (the paper's "unconditioned Aroon strategy" - deliberately implemented here, not the
 * "conditioned" variant, which layers on a "weak down-trend" threshold the paper itself presents
 * as "e.g., 45 in our test" - an empirical number fit to their specific backtest, not a validated
 * universal constant; baking that in as an Argus default would misrepresent it): buy when AroonUp
 * crosses above AroonDown, sell when AroonDown crosses above AroonUp - the same golden-cross/
 * dead-cross framing as the Two-Average strategy, applied to these two lines instead of two MAs.
 */
public final class AroonEngine {

    private AroonEngine() {
    }

    public record Result(
        double aroonUp,
        double aroonDown,
        double aroonOscillator,
        String crossSignal // BUY (AroonUp crossed above AroonDown), SELL (AroonDown crossed above AroonUp), NEUTRAL
    ) {
    }

    private static double aroonUpAt(double[] highs, int end, int period) {
        int highestIdx = end;
        for (int i = end - period; i <= end; i++) {
            if (highs[i] >= highs[highestIdx]) highestIdx = i;
        }
        int periodsSinceHighestHigh = end - highestIdx;
        return 100.0 * (period - periodsSinceHighestHigh) / period;
    }

    private static double aroonDownAt(double[] lows, int end, int period) {
        int lowestIdx = end;
        for (int i = end - period; i <= end; i++) {
            if (lows[i] <= lows[lowestIdx]) lowestIdx = i;
        }
        int periodsSinceLowestLow = end - lowestIdx;
        return 100.0 * (period - periodsSinceLowestLow) / period;
    }

    /**
     * @param highs, lows chronological arrays (same length).
     * @param period      Chande's own conventional default is 25.
     * @return null if there isn't enough history for both the current and the prior bar's Aroon
     *         values (needed to detect a cross).
     */
    public static Result evaluate(double[] highs, double[] lows, int period) {
        if (highs == null || lows == null || highs.length < period + 2) {
            return null;
        }
        int last = highs.length - 1;

        double upNow = aroonUpAt(highs, last, period);
        double downNow = aroonDownAt(lows, last, period);
        double upPrev = aroonUpAt(highs, last - 1, period);
        double downPrev = aroonDownAt(lows, last - 1, period);

        boolean bullishCross = upPrev <= downPrev && upNow > downNow;
        boolean bearishCross = downPrev <= upPrev && downNow > upNow;
        String signal = bullishCross ? "BUY" : bearishCross ? "SELL" : "NEUTRAL";

        return new Result(upNow, downNow, upNow - downNow, signal);
    }

    /** Chande's own conventional 25-period default. */
    public static Result evaluate(double[] highs, double[] lows) {
        return evaluate(highs, lows, 25);
    }
}
