package io.argus.quantcore.institutional.models;

import io.argus.quantcore.stats.RollingStatistics;

/**
 * Classical close-to-close mean-reversion: a real rolling Z-score of price (via the existing
 * RollingStatistics.zScore - no duplicate stats implementation) against a configurable extreme
 * threshold. Covers both "short-term mean reversion" and "extreme-return reversal" as the same
 * underlying signal at different threshold strictness, not two independent models.
 */
public final class MeanReversionZScoreEngine {

    private MeanReversionZScoreEngine() {
    }

    public record Result(
        double zScore,
        boolean extremeOverbought,
        boolean extremeOversold,
        String fadeSignal // SELL (fade an overbought extreme), BUY (fade an oversold extreme), NEUTRAL
    ) {
    }

    /**
     * @param closes         chronological close prices.
     * @param window         Z-score lookback (e.g. 20).
     * @param extremeZScore  |z| beyond this is treated as an extreme worth fading (e.g. 2.0).
     * @return null if the Z-score isn't computable yet (insufficient history or a degenerate flat window).
     */
    public static Result evaluate(double[] closes, int window, double extremeZScore) {
        Double z = RollingStatistics.zScore(closes, window);
        if (z == null) {
            return null;
        }
        boolean overbought = z >= extremeZScore;
        boolean oversold = z <= -extremeZScore;
        String signal = overbought ? "SELL" : oversold ? "BUY" : "NEUTRAL";
        return new Result(z, overbought, oversold, signal);
    }
}
