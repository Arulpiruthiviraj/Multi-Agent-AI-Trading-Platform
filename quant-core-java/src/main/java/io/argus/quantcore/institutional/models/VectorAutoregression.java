package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.OlsRegression;

import java.util.ArrayList;
import java.util.List;

/**
 * VAR(p) - Vector Autoregression: each of k series is regressed (real OLS, one equation at a
 * time - the standard estimation approach, equivalent to full-system MLE under Gaussian errors)
 * on p lags of ALL k series, capturing real cross-series lead/lag relationships
 * {@link AutoregressiveModel} (single-series) cannot.
 */
public final class VectorAutoregression {

    private VectorAutoregression() {
    }

    /** One equation per series; coefficients()[j] is series j's lag-1..lag-p coefficients for THIS equation's own dependent series. */
    public record EquationParams(double intercept, double[][] coefficientsByLagThenSeries, double rSquared) {
    }

    public record Result(EquationParams[] equations) {
        /** @param history rows are chronological observations, columns are series, newest row last; needs >= p rows. */
        public double[] forecastOneStep(double[][] history, int p) {
            int k = equations.length;
            double[] forecast = new double[k];
            for (int eq = 0; eq < k; eq++) {
                double f = equations[eq].intercept();
                for (int lag = 1; lag <= p; lag++) {
                    double[] row = history[history.length - lag];
                    for (int series = 0; series < k; series++) {
                        f += equations[eq].coefficientsByLagThenSeries()[lag - 1][series] * row[series];
                    }
                }
                forecast[eq] = f;
            }
            return forecast;
        }
    }

    /**
     * @param series n observations (rows) x k series (columns), chronological.
     * @param p      lag order.
     * @return null if there isn't enough data for any equation's regression.
     */
    public static Result fit(double[][] series, int p) {
        int n = series.length;
        if (n == 0 || p < 1) {
            return null;
        }
        int k = series[0].length;
        for (double[] row : series) {
            if (row.length != k) return null;
        }
        int rows = n - p;
        if (rows <= p * k + 1) {
            return null;
        }

        double[][] predictors = new double[rows][p * k];
        for (int t = p; t < n; t++) {
            int col = 0;
            for (int lag = 1; lag <= p; lag++) {
                for (int s = 0; s < k; s++) {
                    predictors[t - p][col++] = series[t - lag][s];
                }
            }
        }

        List<EquationParams> equations = new ArrayList<>(k);
        for (int eq = 0; eq < k; eq++) {
            double[] y = new double[rows];
            for (int t = p; t < n; t++) y[t - p] = series[t][eq];

            OlsRegression.Result reg = OlsRegression.fit(predictors, y, true);
            if (reg == null) {
                return null;
            }
            double[][] byLagThenSeries = new double[p][k];
            int col = 1; // skip intercept
            for (int lag = 0; lag < p; lag++) {
                for (int s = 0; s < k; s++) {
                    byLagThenSeries[lag][s] = reg.coefficients()[col++];
                }
            }
            equations.add(new EquationParams(reg.coefficients()[0], byLagThenSeries, reg.rSquared()));
        }

        return new Result(equations.toArray(new EquationParams[0]));
    }
}
