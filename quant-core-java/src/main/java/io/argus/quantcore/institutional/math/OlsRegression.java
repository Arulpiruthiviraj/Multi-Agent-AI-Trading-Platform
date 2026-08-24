package io.argus.quantcore.institutional.math;

/**
 * Ordinary least squares via the normal equations (beta = (X'X)^-1 X'y). Building block for
 * {@link io.argus.quantcore.institutional.math.AugmentedDickeyFuller} (regression on lagged
 * levels/diffs) and {@link io.argus.quantcore.institutional.math.OrnsteinUhlenbeckEstimator}
 * (AR(1) regression), and directly for Engle-Granger cointegration's first-stage regression in
 * StatArbEngine. Small design matrices only (a handful of columns) - see Matrix's own note on
 * why this is hand-rolled rather than a dependency.
 */
public final class OlsRegression {

    private OlsRegression() {
    }

    public record Result(double[] coefficients, double[] residuals, double rSquared, double[] standardErrors) {
    }

    /**
     * @param predictors n x k matrix, NOT including an intercept column.
     * @param y          length-n response vector.
     * @param intercept  when true, prepends a column of 1s; coefficients[0] is then the intercept.
     * @return null if there are fewer observations than parameters, or the design matrix is
     *         singular (collinear predictors / no variation) - never a fabricated fit.
     */
    public static Result fit(double[][] predictors, double[] y, boolean intercept) {
        int n = y.length;
        if (n == 0 || predictors.length != n) {
            return null;
        }
        int kRaw = predictors[0].length;
        int k = intercept ? kRaw + 1 : kRaw;
        if (n <= k) {
            return null;
        }

        double[][] design = new double[n][k];
        for (int i = 0; i < n; i++) {
            int offset = 0;
            if (intercept) {
                design[i][0] = 1.0;
                offset = 1;
            }
            System.arraycopy(predictors[i], 0, design[i], offset, kRaw);
        }

        double[][] xt = Matrix.transpose(design);
        double[][] xtx = Matrix.multiply(xt, design);
        double[][] xtxInv = Matrix.invert(xtx);
        if (xtxInv == null) {
            return null;
        }
        double[] xty = Matrix.multiply(xt, y);
        double[] beta = Matrix.multiply(xtxInv, xty);

        double[] fitted = Matrix.multiply(design, beta);
        double[] residuals = new double[n];
        double meanY = 0;
        for (double v : y) meanY += v;
        meanY /= n;

        double ssRes = 0, ssTot = 0;
        for (int i = 0; i < n; i++) {
            residuals[i] = y[i] - fitted[i];
            ssRes += residuals[i] * residuals[i];
            ssTot += (y[i] - meanY) * (y[i] - meanY);
        }
        double rSquared = ssTot < 1e-15 ? 0.0 : 1.0 - (ssRes / ssTot);

        int dof = n - k;
        double sigma2 = dof > 0 ? ssRes / dof : Double.NaN;
        double[] se = new double[k];
        for (int j = 0; j < k; j++) {
            se[j] = Math.sqrt(sigma2 * xtxInv[j][j]);
        }

        return new Result(beta, residuals, rSquared, se);
    }
}
