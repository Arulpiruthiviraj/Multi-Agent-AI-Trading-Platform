package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.OlsRegression;

/**
 * Futures cross-hedge ratio - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 10.1.1.
 * When no futures contract exists for the exact asset being hedged, a futures contract on a similar
 * asset is used instead (Eq. 463); the paper notes "the optimal hedge ratio may not be 1 and can be
 * estimated via, e.g., a serial regression" (fn. 161). The classical minimum-variance hedge ratio is
 * exactly the OLS beta of the hedged asset's returns regressed on the hedging instrument's returns
 * (Cov(dS,dF)/Var(dF)) - this reuses the existing OlsRegression rather than a new regression
 * implementation, matching the same pattern ResidualReturnEngine already uses for a single-predictor
 * fit.
 */
public final class FuturesCrossHedgeRatioEngine {

    private FuturesCrossHedgeRatioEngine() {
    }

    public record Result(
        double hedgeRatio, // units of the hedging futures contract per unit of the hedged asset
        double rSquared    // how much of the hedged asset's variance this hedge explains
    ) {
    }

    /**
     * @param hedgedAssetReturns   chronological returns of the asset being hedged.
     * @param hedgingFuturesReturns chronological returns of the futures contract used to hedge,
     *                             same length/alignment.
     * @return null if there isn't enough aligned data to regress, or the hedging instrument's
     *         returns have no variance (an undefined ratio, not fabricated as 1.0).
     */
    public static Result evaluate(double[] hedgedAssetReturns, double[] hedgingFuturesReturns) {
        int n = hedgedAssetReturns.length;
        if (hedgingFuturesReturns.length != n || n < 3) {
            return null;
        }
        double[][] predictors = new double[n][1];
        for (int i = 0; i < n; i++) predictors[i][0] = hedgingFuturesReturns[i];

        OlsRegression.Result reg = OlsRegression.fit(predictors, hedgedAssetReturns, true);
        if (reg == null) {
            return null;
        }
        double hedgeRatio = reg.coefficients()[1];
        return new Result(hedgeRatio, reg.rSquared());
    }
}
