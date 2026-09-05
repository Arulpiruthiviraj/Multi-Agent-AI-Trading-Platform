package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.Matrix;

import java.util.Arrays;

/**
 * Markowitz mean-variance portfolio optimization (Markowitz, "Portfolio Selection", J. Finance
 * 1952) - closed-form global-minimum-variance and tangency (max-Sharpe) portfolios via the real
 * covariance-matrix inverse (Matrix.invert - no iterative approximation needed, these have exact
 * closed forms). ADVISORY/RESEARCH ONLY: this NEVER sizes a real order - PositionSizing.ts remains
 * the sole authority for actual trade sizing (CLAUDE.md protected architecture).
 */
public final class MeanVarianceOptimizer {

    private MeanVarianceOptimizer() {
    }

    public record Result(double[] weights, double expectedReturn, double expectedVolatility) {
    }

    /** @return null if the covariance matrix isn't invertible (degenerate/singular). */
    public static Result minimumVariancePortfolio(double[][] covariance) {
        int k = covariance.length;
        double[][] inv = Matrix.invert(covariance);
        if (inv == null) {
            return null;
        }
        double[] ones = new double[k];
        Arrays.fill(ones, 1.0);
        double[] numerator = Matrix.multiply(inv, ones);
        double denom = dot(ones, numerator);
        if (denom == 0) {
            return null;
        }
        double[] weights = new double[k];
        for (int i = 0; i < k; i++) weights[i] = numerator[i] / denom;
        double vol = Math.sqrt(quadForm(weights, covariance));
        return new Result(weights, Double.NaN, vol);
    }

    /**
     * @param expectedReturns real, caller-supplied expected returns (e.g. from a backtest or
     *                        factor model) - this optimizer never invents them.
     * @param riskFreeRate    per-period risk-free rate, same units as expectedReturns.
     * @return null if the covariance matrix isn't invertible or excess returns net to zero exposure.
     */
    public static Result tangencyPortfolio(double[][] covariance, double[] expectedReturns, double riskFreeRate) {
        int k = covariance.length;
        if (expectedReturns.length != k) {
            return null;
        }
        double[][] inv = Matrix.invert(covariance);
        if (inv == null) {
            return null;
        }
        double[] excessReturns = new double[k];
        for (int i = 0; i < k; i++) excessReturns[i] = expectedReturns[i] - riskFreeRate;
        double[] numerator = Matrix.multiply(inv, excessReturns);
        double[] ones = new double[k];
        Arrays.fill(ones, 1.0);
        double denom = dot(ones, numerator);
        if (denom == 0) {
            return null;
        }
        double[] weights = new double[k];
        for (int i = 0; i < k; i++) weights[i] = numerator[i] / denom;
        double expReturn = dot(weights, expectedReturns);
        double vol = Math.sqrt(quadForm(weights, covariance));
        return new Result(weights, expReturn, vol);
    }

    private static double dot(double[] a, double[] b) {
        double s = 0;
        for (int i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
    }

    private static double quadForm(double[] w, double[][] covariance) {
        double[] sigmaW = Matrix.multiply(covariance, w);
        return dot(w, sigmaW);
    }
}
