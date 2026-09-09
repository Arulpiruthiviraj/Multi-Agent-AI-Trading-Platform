package io.argus.quantcore.institutional.models;

/**
 * MAX effect / lottery-demand anomaly - Bali, Cakici &amp; Whitelaw, "Maxing Out: Stocks as
 * Lotteries and the Cross-Section of Expected Returns," J. Financial Economics 2011. Finding:
 * stocks with extreme recent single-day maximum returns ("lottery-like" payoffs) subsequently
 * underperform, consistent with investors overpaying for lottery-like upside.
 *
 * MAX = the single largest daily return within a trailing window (the paper's own headline
 * measure uses the average of the 5 highest days in a month; both the single-max and top-K-average
 * variants are offered here, real and separately computable, not one standing in for the other).
 *
 * This is a single-symbol signal (a real MAX value for this stock right now), not the paper's own
 * cross-sectional "short the highest-MAX decile" portfolio construction, which needs ranking
 * across a real universe - out of scope for a single-symbol engine, same honest limitation
 * MarketModelResidualEngine.java's own doc comment already flags for the beta/IVOL anomalies.
 */
public final class MaxEffectEngine {

    private MaxEffectEngine() {
    }

    public record Result(
        double maxDailyReturn,      // the single highest daily return in the window
        double topKAverageReturn,   // average of the topK highest daily returns in the window (paper's own headline measure)
        boolean extremeLotteryDemand // maxDailyReturn at/beyond the caller-supplied threshold
    ) {
    }

    /**
     * @param closes    chronological closes.
     * @param window    trailing window in trading days (paper's own convention: ~1 month, e.g. 21).
     * @param topK      how many of the window's highest daily returns to average (paper's own
     *                  headline measure uses 5).
     * @param threshold single-day return at/beyond which counts as "extreme" (caller-supplied,
     *                  not defaulted - matches this session's established convention of not
     *                  baking in a specific number the source paper fit to its own sample).
     * @return null if there isn't enough history, or topK exceeds the number of return
     *         observations in the window.
     */
    public static Result evaluate(double[] closes, int window, int topK, double threshold) {
        int n = closes.length;
        if (window < 1 || n <= window || topK < 1 || topK > window) {
            return null;
        }
        double[] dailyReturns = new double[window];
        for (int i = 0; i < window; i++) {
            int idx = n - window + i;
            double prev = closes[idx - 1];
            if (prev == 0) {
                return null;
            }
            dailyReturns[i] = (closes[idx] - prev) / prev;
        }
        double[] sorted = dailyReturns.clone();
        java.util.Arrays.sort(sorted);
        double maxDailyReturn = sorted[sorted.length - 1];
        double topKSum = 0;
        for (int i = 0; i < topK; i++) {
            topKSum += sorted[sorted.length - 1 - i];
        }
        double topKAverageReturn = topKSum / topK;

        return new Result(maxDailyReturn, topKAverageReturn, maxDailyReturn >= threshold);
    }

    /** Paper's own headline convention: ~1 trading month window, top-5 average. */
    public static Result evaluate(double[] closes, double threshold) {
        return evaluate(closes, 21, 5, threshold);
    }
}
