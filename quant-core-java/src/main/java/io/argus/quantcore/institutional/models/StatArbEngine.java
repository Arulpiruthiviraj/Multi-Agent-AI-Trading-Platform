package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.AugmentedDickeyFuller;
import io.argus.quantcore.institutional.math.OlsRegression;
import io.argus.quantcore.institutional.math.OrnsteinUhlenbeckEstimator;
import io.argus.quantcore.stats.RollingStatistics;

/**
 * Engle-Granger two-step cointegration test between a pair of price series, plus the spread
 * diagnostics a StatArb strategy needs to trade it: current Z-score and half-life (via
 * Ornstein-Uhlenbeck, since a cointegrated spread is modeled as mean-reverting around its
 * equilibrium).
 *
 * Step 1: OLS priceA ~ priceB (+intercept) -&gt; hedge ratio. Step 2: ADF test on the regression
 * residual (the spread) - rejecting the unit-root null is evidence the pair is cointegrated.
 */
public final class StatArbEngine {

    private StatArbEngine() {
    }

    public record PairResult(
        double hedgeRatio,
        double intercept,
        double[] spread,
        AugmentedDickeyFuller.Result adf,
        boolean cointegrated,
        Double currentZScore,
        OrnsteinUhlenbeckEstimator.Result ouParams,
        Double halfLifeBars
    ) {
    }

    /**
     * @param priceA        series A, chronological.
     * @param priceB        series B, same length/alignment as priceA.
     * @param zScoreWindow  window for the spread's current Z-score (e.g. 60).
     * @return null if there isn't enough data to regress and ADF-test the residual.
     */
    public static PairResult evaluatePair(double[] priceA, double[] priceB, int zScoreWindow) {
        int n = priceA.length;
        if (n != priceB.length || n < 30) {
            return null;
        }

        double[][] predictors = new double[n][1];
        for (int i = 0; i < n; i++) predictors[i][0] = priceB[i];
        OlsRegression.Result reg = OlsRegression.fit(predictors, priceA, true);
        if (reg == null) {
            return null;
        }

        double intercept = reg.coefficients()[0];
        double hedgeRatio = reg.coefficients()[1];
        double[] spread = reg.residuals();

        int lags = AugmentedDickeyFuller.suggestLags(spread.length);
        AugmentedDickeyFuller.Result adf = AugmentedDickeyFuller.test(spread, lags);
        boolean cointegrated = adf != null && adf.isStationaryAt5Pct();

        Double zScore = RollingStatistics.zScore(spread, zScoreWindow);
        OrnsteinUhlenbeckEstimator.Result ou = OrnsteinUhlenbeckEstimator.estimate(spread, 1.0);
        Double halfLife = ou != null ? ou.halfLife() : null;

        return new PairResult(hedgeRatio, intercept, spread, adf, cointegrated, zScore, ou, halfLife);
    }
}
