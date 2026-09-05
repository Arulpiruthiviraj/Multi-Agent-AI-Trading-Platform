package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.OlsRegression;

/**
 * AR(p) - an autoregressive model is literally OLS of y_t on its own p lags, so this reuses
 * OlsRegression rather than re-deriving the normal equations. {@link VectorAutoregression} builds
 * on this same idea for the multivariate case.
 */
public final class AutoregressiveModel {

    private AutoregressiveModel() {
    }

    public record Params(double intercept, double[] lagCoefficients, double[] residuals, double rSquared) {
        public double forecastOneStep(double[] mostRecentValuesNewestLast) {
            double f = intercept;
            int p = lagCoefficients.length;
            for (int lag = 1; lag <= p; lag++) {
                f += lagCoefficients[lag - 1] * mostRecentValuesNewestLast[mostRecentValuesNewestLast.length - lag];
            }
            return f;
        }
    }

    /**
     * @param series chronological series (levels or already-differenced returns).
     * @param p      autoregressive order (number of lags).
     * @return null if there isn't enough data (needs at least p+2 observations after lagging).
     */
    public static Params fit(double[] series, int p) {
        int n = series.length;
        if (p < 1 || n <= p + 1) {
            return null;
        }
        int rows = n - p;
        double[][] predictors = new double[rows][p];
        double[] y = new double[rows];
        for (int t = p; t < n; t++) {
            y[t - p] = series[t];
            for (int lag = 1; lag <= p; lag++) {
                predictors[t - p][lag - 1] = series[t - lag];
            }
        }
        OlsRegression.Result reg = OlsRegression.fit(predictors, y, true);
        if (reg == null) {
            return null;
        }
        double intercept = reg.coefficients()[0];
        double[] lagCoefficients = new double[p];
        System.arraycopy(reg.coefficients(), 1, lagCoefficients, 0, p);
        return new Params(intercept, lagCoefficients, reg.residuals(), reg.rSquared());
    }
}
