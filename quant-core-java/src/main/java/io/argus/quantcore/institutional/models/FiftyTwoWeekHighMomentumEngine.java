package io.argus.quantcore.institutional.models;

/**
 * 52-week-high momentum - George &amp; Hwang, "The 52-Week High and Momentum Investing,"
 * J. Finance 2004. Finding: a stock's nearness to its own 52-week high is a stronger, more
 * behaviorally-grounded momentum predictor than raw trailing return (their explanation: the
 * 52-week high acts as a salient reference point/anchor investors under-react around, distinct
 * from - and empirically dominant over, per the paper - the standard Jegadeesh-Titman trailing-
 * return momentum measure TimeSeriesMomentumEngine.java already covers).
 *
 * nearness = currentClose / highest close over the trailing window (window's own convention: 252
 * trading days = "52 weeks" of daily bars). Nearness close to 1.0 (near the high) reads bullish;
 * far below reads as no-signal, not bearish - the paper's own finding is specifically about
 * proximity-to-high continuation, not a symmetric "far from high predicts decline" claim.
 */
public final class FiftyTwoWeekHighMomentumEngine {

    private FiftyTwoWeekHighMomentumEngine() {
    }

    public record Result(
        double fiftyTwoWeekHigh,
        double currentClose,
        double nearnessRatio, // currentClose / fiftyTwoWeekHigh, in (0, 1]
        boolean nearHigh,     // nearnessRatio at/above the caller-supplied threshold
        String signal         // BUY (near high), NEUTRAL
    ) {
    }

    /**
     * @param closes    chronological closes.
     * @param window    trading days defining "52 weeks" (conventional default: 252).
     * @param threshold nearness ratio at/above which counts as "near the high" (caller-supplied -
     *                  the paper's own empirical cutoffs were fit to their sample deciles, not a
     *                  universal constant; e.g. 0.95 is a common practitioner convention, not
     *                  defaulted here).
     * @return null if there isn't enough history, or the 52-week high is non-positive.
     */
    public static Result evaluate(double[] closes, int window, double threshold) {
        int n = closes.length;
        if (window < 1 || n < window) {
            return null;
        }
        double high = Double.NEGATIVE_INFINITY;
        for (int i = n - window; i < n; i++) {
            if (closes[i] > high) high = closes[i];
        }
        if (high <= 0) {
            return null;
        }
        double current = closes[n - 1];
        double nearness = current / high;
        boolean near = nearness >= threshold;
        return new Result(high, current, nearness, near, near ? "BUY" : "NEUTRAL");
    }

    /** Conventional 252-trading-day ("52-week") window. */
    public static Result evaluate(double[] closes, double threshold) {
        return evaluate(closes, 252, threshold);
    }
}
