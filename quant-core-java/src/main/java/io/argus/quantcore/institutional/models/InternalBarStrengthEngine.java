package io.argus.quantcore.institutional.models;

/**
 * Internal Bar Strength (IBS) mean reversion - Kakushadze &amp; Serur, "151 Trading Strategies"
 * (2018), Section 4.4. IBS = (Close - Low) / (High - Low), a bounded [0,1] measure of where a
 * bar's close sits within its own high-low range. The paper's own well-documented empirical
 * regularity (most studied on ETFs) is short-horizon mean reversion: a bar closing near its low
 * (IBS near 0) tends to be followed by a bounce, and one closing near its high (IBS near 1) tends
 * to be followed by a pullback - buy low-IBS, sell/avoid high-IBS.
 */
public final class InternalBarStrengthEngine {

    private InternalBarStrengthEngine() {
    }

    public record Result(
        double ibs,
        String signal // BUY (ibs <= lowThreshold), SELL (ibs >= highThreshold), NEUTRAL
    ) {
    }

    /**
     * @param high, low, close today's (or the most recently completed) bar's OHLC range values.
     * @param lowThreshold  IBS at/below this triggers BUY (paper's own worked examples commonly
     *                      use 0.2 - not defaulted here; caller supplies it explicitly).
     * @param highThreshold IBS at/above this triggers SELL (commonly 0.8 in the same convention).
     * @return null if the bar's high-low range is zero or degenerate (IBS is genuinely undefined,
     *         not fabricated as 0 or 0.5).
     */
    public static Result evaluate(double high, double low, double close, double lowThreshold, double highThreshold) {
        double range = high - low;
        if (range <= 0 || Double.isNaN(range)) {
            return null;
        }
        double ibs = (close - low) / range;

        String signal = ibs <= lowThreshold ? "BUY" : ibs >= highThreshold ? "SELL" : "NEUTRAL";
        return new Result(ibs, signal);
    }

    /** Paper's own commonly-cited worked thresholds: 0.2 / 0.8. */
    public static Result evaluate(double high, double low, double close) {
        return evaluate(high, low, close, 0.2, 0.8);
    }
}
