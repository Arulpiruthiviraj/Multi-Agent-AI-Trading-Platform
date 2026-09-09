package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.Matrix;

/**
 * Volatility carry hedge ratios - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section
 * 7.3, footnote 131 (simple 2-ETN hedge ratio h = rho*sigmaX/sigmaZ) and Section 7.3.1, Eq. 432
 * (basket-of-futures hedge weights via inverse covariance). E.g. short VXX (roll-loss decay from
 * VIX futures contango) hedged with a long position in VXZ or a basket of medium-maturity VIX
 * futures.
 */
public final class VolatilityCarryHedgeRatioEngine {

    private VolatilityCarryHedgeRatioEngine() {
    }

    /** Footnote 131: simple two-instrument hedge ratio h = rho * sigmaX / sigmaZ (units of the hedge instrument per unit shorted). */
    public static Double simpleHedgeRatio(double correlation, double volatilityX, double volatilityZ) {
        if (volatilityZ <= 0) {
            return null;
        }
        return correlation * volatilityX / volatilityZ;
    }

    /**
     * Eq. 432: basket hedge weights w_i = sigma_X * sum_j(C^-1_ij * sigma_j * rho_j), minimizing
     * tracking error against the position being hedged (e.g. VXX).
     *
     * @param hedgedVolatility  sigma_X, historical volatility of the position being hedged.
     * @param covarianceMatrix  C, the N x N sample covariance matrix of the N hedging instruments.
     * @param correlationsWithHedged rho_i, each hedging instrument's historical correlation with
     *                          the hedged position.
     * @return null if the covariance matrix is singular (Matrix.invert's own contract) or
     *         dimensions are mismatched.
     */
    public static double[] basketHedgeWeights(double hedgedVolatility, double[][] covarianceMatrix, double[] correlationsWithHedged) {
        int n = covarianceMatrix.length;
        if (correlationsWithHedged.length != n) {
            return null;
        }
        double[][] inv = Matrix.invert(covarianceMatrix);
        if (inv == null) {
            return null;
        }
        double[] volTimesRho = new double[n];
        for (int i = 0; i < n; i++) {
            double sigma_i = Math.sqrt(covarianceMatrix[i][i]);
            volTimesRho[i] = sigma_i * correlationsWithHedged[i];
        }
        double[] weighted = Matrix.multiply(inv, volTimesRho);
        double[] weights = new double[n];
        for (int i = 0; i < n; i++) {
            weights[i] = hedgedVolatility * weighted[i];
        }
        return weights;
    }
}
