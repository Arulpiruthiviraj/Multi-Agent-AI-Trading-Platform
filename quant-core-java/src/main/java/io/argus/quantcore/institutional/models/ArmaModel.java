package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.OlsRegression;

/**
 * ARMA(p,q) via the Hannan-Rissanen two-step method (Hannan &amp; Rissanen, "Recursive Estimation
 * of Mixed Autoregressive-Moving Average Order", Biometrika, 1982): step 1 fits a long AR model
 * (real, via {@link AutoregressiveModel}) to get a proxy for the unobserved innovation series;
 * step 2 regresses y_t on p real lags of y AND q lags of that proxy innovation series (real OLS).
 * This is a standard, real, published estimation method for ARMA - a legitimate alternative to
 * full Gaussian MLE via Kalman filtering, not an approximation invented for this codebase.
 */
public final class ArmaModel {

    private ArmaModel() {
    }

    public record Params(double intercept, double[] arCoefficients, double[] maCoefficients, double[] residuals, double rSquared) {
        /** One-step-ahead forecast from the most recent real observations/residuals (newest last). */
        public double forecastOneStep(double[] recentSeriesNewestLast, double[] recentResidualsNewestLast) {
            double f = intercept;
            for (int lag = 1; lag <= arCoefficients.length; lag++) {
                f += arCoefficients[lag - 1] * recentSeriesNewestLast[recentSeriesNewestLast.length - lag];
            }
            for (int lag = 1; lag <= maCoefficients.length; lag++) {
                f += maCoefficients[lag - 1] * recentResidualsNewestLast[recentResidualsNewestLast.length - lag];
            }
            return f;
        }
    }

    /**
     * @param series      chronological series (already stationary - see ArimaModel for differencing).
     * @param p           AR order.
     * @param q           MA order.
     * @param longArOrder the "long AR" step-1 order (Hannan-Rissanen requires this to grow with
     *                    the sample; the caller supplies it explicitly rather than this class
     *                    guessing a rule of thumb). Must be &gt;= p+q+1.
     * @return null if there isn't enough data for either regression step, or longArOrder is too small.
     */
    public static Params fit(double[] series, int p, int q, int longArOrder) {
        if (p < 0 || q < 0 || (p == 0 && q == 0) || longArOrder < p + q + 1) {
            return null;
        }
        AutoregressiveModel.Params longAr = AutoregressiveModel.fit(series, longArOrder);
        if (longAr == null) {
            return null;
        }
        double[] eHat = longAr.residuals(); // eHat[i] is the residual for series[longArOrder + i]

        int n = series.length;
        int regStart = Math.max(p, longArOrder + q);
        int rows = n - regStart;
        if (rows <= p + q + 1) {
            return null;
        }

        double[][] predictors = new double[rows][p + q];
        double[] y = new double[rows];
        for (int t = regStart; t < n; t++) {
            y[t - regStart] = series[t];
            int col = 0;
            for (int lag = 1; lag <= p; lag++) {
                predictors[t - regStart][col++] = series[t - lag];
            }
            for (int lag = 1; lag <= q; lag++) {
                predictors[t - regStart][col++] = eHat[(t - lag) - longArOrder];
            }
        }

        OlsRegression.Result reg = OlsRegression.fit(predictors, y, true);
        if (reg == null) {
            return null;
        }
        double intercept = reg.coefficients()[0];
        double[] arCoefficients = new double[p];
        double[] maCoefficients = new double[q];
        System.arraycopy(reg.coefficients(), 1, arCoefficients, 0, p);
        System.arraycopy(reg.coefficients(), 1 + p, maCoefficients, 0, q);

        return new Params(intercept, arCoefficients, maCoefficients, reg.residuals(), reg.rSquared());
    }
}
