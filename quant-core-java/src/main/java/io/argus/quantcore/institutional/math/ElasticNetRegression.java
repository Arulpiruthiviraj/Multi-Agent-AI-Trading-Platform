package io.argus.quantcore.institutional.math;

/**
 * Elastic Net (L1 + L2 penalized regression) via cyclic coordinate descent - the standard
 * algorithm (Friedman, Hastie &amp; Tibshirani, "Regularization Paths for Generalized Linear
 * Models via Coordinate Descent", 2010; the same approach glmnet uses). Lasso and Ridge are both
 * special cases of this same solver (l1Ratio=1.0 and l1Ratio=0.0 respectively) - implemented once
 * here rather than as three separate, drifting coordinate-descent loops. {@link RidgeRegression}
 * still exists separately because Ridge alone has an exact closed form (no iteration needed) -
 * this class is for whenever an L1 term is actually wanted.
 *
 * Predictors and the response are internally centered (standard practice); the intercept is
 * recovered afterward from the un-centered means, not penalized.
 */
public final class ElasticNetRegression {

    private ElasticNetRegression() {
    }

    public record Result(double intercept, double[] coefficients, double[] residuals, int iterations, boolean converged) {
    }

    private static double softThreshold(double rho, double gamma) {
        if (rho > gamma) return rho - gamma;
        if (rho < -gamma) return rho + gamma;
        return 0.0;
    }

    /**
     * @param predictors    n x k matrix, NOT including an intercept column.
     * @param y             length-n response vector.
     * @param lambda        overall penalty strength (&gt;= 0).
     * @param l1Ratio       in [0,1]: 1.0 = pure Lasso, 0.0 = pure (coordinate-descent) Ridge.
     * @param maxIterations coordinate-descent sweep cap (e.g. 1000).
     * @param tolerance     stop once the largest per-sweep coefficient change is below this (e.g. 1e-6).
     * @return null for degenerate inputs (mismatched lengths, invalid lambda/l1Ratio, too few rows).
     */
    public static Result fit(double[][] predictors, double[] y, double lambda, double l1Ratio, int maxIterations, double tolerance) {
        int n = y.length;
        if (n <= 1 || predictors.length != n || lambda < 0 || l1Ratio < 0 || l1Ratio > 1 || maxIterations < 1) {
            return null;
        }
        int k = predictors[0].length;
        if (k == 0) {
            return null;
        }

        double yMean = mean(y);
        double[] xMeans = new double[k];
        double[][] xc = new double[n][k];
        for (int j = 0; j < k; j++) {
            double m = 0;
            for (int i = 0; i < n; i++) m += predictors[i][j];
            m /= n;
            xMeans[j] = m;
            for (int i = 0; i < n; i++) xc[i][j] = predictors[i][j] - m;
        }
        double[] yc = new double[n];
        for (int i = 0; i < n; i++) yc[i] = y[i] - yMean;

        double[] colSumSq = new double[k];
        for (int j = 0; j < k; j++) {
            double s = 0;
            for (int i = 0; i < n; i++) s += xc[i][j] * xc[i][j];
            colSumSq[j] = s;
        }

        double l1 = lambda * l1Ratio;
        double l2 = lambda * (1 - l1Ratio);

        double[] beta = new double[k];
        double[] r = yc.clone(); // residual with beta = 0

        int iter = 0;
        boolean converged = false;
        for (; iter < maxIterations; iter++) {
            double maxDelta = 0;
            for (int j = 0; j < k; j++) {
                double betaOld = beta[j];
                if (betaOld != 0) {
                    for (int i = 0; i < n; i++) r[i] += xc[i][j] * betaOld;
                }
                double rho = 0;
                for (int i = 0; i < n; i++) rho += xc[i][j] * r[i];
                double denom = colSumSq[j] + l2;
                double betaNew = denom > 1e-12 ? softThreshold(rho, l1) / denom : 0.0;
                if (betaNew != 0) {
                    for (int i = 0; i < n; i++) r[i] -= xc[i][j] * betaNew;
                }
                maxDelta = Math.max(maxDelta, Math.abs(betaNew - betaOld));
                beta[j] = betaNew;
            }
            if (maxDelta < tolerance) {
                converged = true;
                iter++;
                break;
            }
        }

        double interceptTerm = 0;
        for (int j = 0; j < k; j++) interceptTerm += xMeans[j] * beta[j];
        double intercept = yMean - interceptTerm;

        double[] residuals = new double[n];
        for (int i = 0; i < n; i++) {
            double fitted = intercept;
            for (int j = 0; j < k; j++) fitted += predictors[i][j] * beta[j];
            residuals[i] = y[i] - fitted;
        }

        return new Result(intercept, beta, residuals, iter, converged);
    }

    private static double mean(double[] values) {
        double s = 0;
        for (double v : values) s += v;
        return s / values.length;
    }
}
