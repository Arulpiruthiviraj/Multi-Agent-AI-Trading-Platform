package io.argus.quantcore.institutional.models;

import io.argus.quantcore.stats.RollingStatistics;

/**
 * Volatility mean reversion: volatility itself is well-documented to mean-revert (distinct from
 * GarchEngine's conditional-variance forecast). Builds a realized-volatility time series from real
 * returns and Z-scores it against its own trailing history, reusing RollingStatistics rather than
 * a new stats implementation.
 */
public final class VolatilityMeanReversionEngine {

    private VolatilityMeanReversionEngine() {
    }

    public record Result(
        double currentRealizedVol,
        double volZScore,
        boolean volExtremeHigh,
        boolean volExtremeLow
    ) {
    }

    /**
     * @param closes        chronological close prices.
     * @param volWindow     window used to compute each point of the realized-vol series (e.g. 10).
     * @param zWindow       how far back to Z-score that vol series against its own history (e.g. 60).
     * @param extremeZScore |z| beyond this counts as an extreme (e.g. 2.0).
     * @return null if there isn't enough data to build both a vol series and Z-score it.
     */
    public static Result evaluate(double[] closes, int volWindow, int zWindow, double extremeZScore) {
        double[] returns = RollingStatistics.rollingReturns(closes);
        if (returns.length <= volWindow + zWindow) {
            return null;
        }
        double[] volSeries = new double[returns.length - volWindow + 1];
        for (int i = volWindow - 1; i < returns.length; i++) {
            double[] window = new double[volWindow];
            System.arraycopy(returns, i - volWindow + 1, window, 0, volWindow);
            Double vol = RollingStatistics.rollingStdDev(window, volWindow);
            if (vol == null) {
                return null;
            }
            volSeries[i - volWindow + 1] = vol;
        }
        Double z = RollingStatistics.zScore(volSeries, zWindow);
        if (z == null) {
            return null;
        }
        return new Result(volSeries[volSeries.length - 1], z, z >= extremeZScore, z <= -extremeZScore);
    }
}
