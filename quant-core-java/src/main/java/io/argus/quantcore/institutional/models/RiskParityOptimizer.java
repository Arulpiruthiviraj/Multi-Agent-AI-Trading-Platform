package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.Matrix;

import java.util.Arrays;

/**
 * Risk Parity / Equal Risk Contribution portfolio: iteratively reweights so every asset
 * contributes the same share of total portfolio risk (Maillard, Roncalli &amp; Teiletche, "The
 * Properties of Equally Weighted Risk Contribution Portfolios", J. Portfolio Management 2010) -
 * no closed form exists in general (unlike mean-variance), so this uses a multiplicative-update
 * iteration: each asset's weight is rescaled by (target risk contribution / its current risk
 * contribution), renormalized, then damped by averaging with the PRIOR weights (a standard fix -
 * the un-damped update is a real, known-to-oscillate fixed-point iteration for some covariance
 * structures, verified live during this implementation on a simple 2-asset case that cycled
 * between two weight vectors forever without damping) until contributions converge to equal.
 * ADVISORY/RESEARCH ONLY - never sizes a real order.
 */
public final class RiskParityOptimizer {

    private RiskParityOptimizer() {
    }

    public record Result(double[] weights, double[] riskContributions, int iterations, boolean converged) {
    }

    /**
     * @param covariance    k x k real covariance matrix.
     * @param maxIterations sweep cap (e.g. 500).
     * @param tolerance     stop once the largest per-sweep weight change is below this (e.g. 1e-8).
     * @return null for a degenerate (non-square, zero-size) covariance matrix.
     */
    public static Result solve(double[][] covariance, int maxIterations, double tolerance) {
        int k = covariance.length;
        if (k == 0 || maxIterations < 1) {
            return null;
        }
        for (double[] row : covariance) {
            if (row.length != k) return null;
        }

        double[] w = new double[k];
        Arrays.fill(w, 1.0 / k);

        int iter = 0;
        boolean converged = false;
        double[] riskContributions = new double[k];
        for (; iter < maxIterations; iter++) {
            double[] sigmaW = Matrix.multiply(covariance, w);
            double portfolioVar = dot(w, sigmaW);
            double portfolioVol = Math.sqrt(Math.max(portfolioVar, 0));
            if (portfolioVol < 1e-12) {
                break;
            }
            for (int i = 0; i < k; i++) riskContributions[i] = w[i] * sigmaW[i] / portfolioVol;

            double targetRc = portfolioVol / k;
            double[] newW = new double[k];
            for (int i = 0; i < k; i++) {
                double ratio = riskContributions[i] > 1e-12 ? targetRc / riskContributions[i] : 1.0;
                newW[i] = w[i] * ratio;
            }
            double sum = 0;
            for (double v : newW) sum += v;
            if (sum <= 0) {
                break;
            }
            for (int i = 0; i < k; i++) newW[i] /= sum;

            // Damping: blend with the prior weights before comparing/committing. The raw
            // (undamped) update is a real fixed-point iteration that can cycle between two weight
            // vectors indefinitely for some covariance structures rather than converging - this
            // blend is the standard fix, not a tolerance workaround.
            double[] dampedW = new double[k];
            for (int i = 0; i < k; i++) dampedW[i] = 0.5 * w[i] + 0.5 * newW[i];

            double maxDelta = 0;
            for (int i = 0; i < k; i++) maxDelta = Math.max(maxDelta, Math.abs(dampedW[i] - w[i]));
            w = dampedW;
            if (maxDelta < tolerance) {
                converged = true;
                iter++;
                break;
            }
        }

        return new Result(w, riskContributions, iter, converged);
    }

    private static double dot(double[] a, double[] b) {
        double s = 0;
        for (int i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
    }
}
