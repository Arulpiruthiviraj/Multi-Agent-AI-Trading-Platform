package io.argus.quantcore.institutional.math;

/**
 * Ridge regression (L2-regularized OLS, Tikhonov regularization) - closed form:
 * beta = (X'X + lambda*I)'^-1 X'y. Explicitly called out in the Two-Sigma-style catalog this
 * engine targets. The intercept column (when present) is conventionally NOT penalized - only the
 * real coefficient rows have lambda added to their diagonal, matching the standard convention
 * (glmnet, scikit-learn) so lambda=0 degenerates exactly to OlsRegression's own fit.
 */
public final class RidgeRegression {

    private RidgeRegression() {
    }

    public record Result(double[] coefficients, double[] residuals, double rSquared) {
    }

    /**
     * @param predictors n x k matrix, NOT including an intercept column.
     * @param y          length-n response vector.
     * @param lambda     L2 penalty strength (>= 0; 0 reduces to plain OLS).
     * @param intercept  when true, prepends an unpenalized intercept column.
     * @return null if there are fewer observations than parameters, or the regularized design
     *         matrix is still singular (should only happen for a pathological lambda &lt; 0 or NaN input).
     */
    public static Result fit(double[][] predictors, double[] y, double lambda, boolean intercept) {
        int n = y.length;
        if (n == 0 || predictors.length != n || lambda < 0) {
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
        int interceptOffset = intercept ? 1 : 0;
        for (int j = interceptOffset; j < k; j++) {
            xtx[j][j] += lambda;
        }
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

        return new Result(beta, residuals, rSquared);
    }
}
