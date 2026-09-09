package io.argus.quantcore.indicators;

/**
 * Kaufman's Efficiency Ratio (a.k.a. Effective Ratio, ER) - Perry J. Kaufman's public-domain
 * indicator (Kaufman, "Smarter Trading", 1995; "Trading Systems and Methods", 2013), the same
 * ratio used to drive the smoothing constant in KAMA (Kaufman Adaptive Moving Average). Measures
 * how directly a series has moved over a window versus how much total (round-trip) movement
 * occurred: net directional change divided by the sum of absolute bar-to-bar changes. Bounded in
 * [-1, 1] by construction - +1/-1 means every bar moved the same direction (a maximally efficient
 * trend), 0 means the net movement was fully offset by back-and-forth noise (no trend).
 *
 * Generic over any series (price, VIX, or otherwise) - this class does not know or care what the
 * input represents. See VixEffectiveRatioFilterEngine for the specific application from Lu &amp; Wu,
 * "A note on VIX for postprocessing quantitative strategies" (2022), which applies this same
 * formula to a VIX series rather than the price series it is usually applied to.
 */
public final class EffectiveRatio {

    private EffectiveRatio() {
    }

    /**
     * @param series chronological values (oldest first); {@code series[series.length - 1]} is the
     *               most recent known value.
     * @param window lookback window M.
     * @return the ER as of the most recent value in {@code series}, using only
     *         {@code series[series.length - 1 - window .. series.length - 1]} - i.e. it never
     *         looks past the last element actually supplied, so callers control look-ahead safety
     *         entirely through what they pass in. Returns {@code Double.NaN} (never a fabricated
     *         0) when {@code window < 1} or there isn't enough history ({@code series.length <
     *         window + 1}), or when the denominator is exactly zero (a perfectly flat window -
     *         genuinely undefined, not "no trend").
     */
    public static double calculate(double[] series, int window) {
        if (window < 1 || series == null || series.length < window + 1) {
            return Double.NaN;
        }
        int last = series.length - 1;
        double netChange = series[last] - series[last - window];
        double sumAbsChange = 0;
        for (int i = last; i > last - window; i--) {
            sumAbsChange += Math.abs(series[i] - series[i - 1]);
        }
        if (sumAbsChange == 0) {
            return Double.NaN;
        }
        return netChange / sumAbsChange;
    }
}
