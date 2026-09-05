package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.Matrix;
import io.argus.quantcore.institutional.math.NelderMeadOptimizer;

/**
 * Multivariate GARCH via Dynamic Conditional Correlation (Engle, "Dynamic Conditional
 * Correlation: A Simple Class of Multivariate GARCH Models", J. Business &amp; Economic
 * Statistics, 2002) - the standard real, practical multivariate-GARCH estimation method, via
 * Engle's own two-step procedure:
 *
 * <p>Step 1: fit a real univariate {@link GarchEngine} to each series independently, standardize
 * each series' returns by its own conditional volatility to get z_t (real, not fabricated).
 *
 * <p>Step 2: fit only the two DCC parameters (a, b) by maximizing the concentrated (correlation-
 * only) quasi-log-likelihood of the recursion
 * <pre>  Q_t = (1-a-b)*Qbar + a*(z_{t-1} z_{t-1}') + b*Q_{t-1}, R_t = diag(Q_t)^-1/2 Q_t diag(Q_t)^-1/2  </pre>
 * where Qbar is the real sample covariance of the standardized residuals - via the same
 * Nelder-Mead MLE pattern GarchEngine/EgarchEngine already use.
 *
 * This is a genuine simplification relative to full one-step DCC MLE (which jointly refits the
 * univariate GARCH parameters too) - Engle's own paper shows the two-step estimator is consistent
 * and is what's used in practice, not a shortcut invented for this codebase.
 */
public final class DccGarchEngine {

    private DccGarchEngine() {
    }

    /** a+b &lt; 1 (DCC stationarity) is guaranteed by the fitting reparameterization, never checked after the fact. */
    public record Params(double a, double b, double[][] unconditionalCorrelation, GarchEngine.Params[] univariateGarch) {
    }

    public record Result(Params params, double[][][] correlationPath) {
    }

    /**
     * @param returns n observations (rows) x k series (columns), chronological.
     * @return null if k &lt; 2 (DCC needs at least two series), any series has too little data for
     *         its own univariate GARCH fit, or the covariance of standardized residuals is degenerate.
     */
    public static Result fit(double[][] returns) {
        int n = returns.length;
        if (n == 0) {
            return null;
        }
        int k = returns[0].length;
        if (k < 2) {
            return null;
        }
        for (double[] row : returns) {
            if (row.length != k) return null;
        }

        GarchEngine.Params[] garchParams = new GarchEngine.Params[k];
        double[][] z = new double[n][k];
        for (int s = 0; s < k; s++) {
            double[] seriesReturns = column(returns, s);
            GarchEngine.Params p = GarchEngine.fit(seriesReturns);
            if (p == null) {
                return null;
            }
            garchParams[s] = p;
            double[] sigma2Path = GarchEngine.conditionalVariancePath(seriesReturns, p);
            for (int t = 0; t < n; t++) {
                z[t][s] = sigma2Path[t] > 0 ? seriesReturns[t] / Math.sqrt(sigma2Path[t]) : 0;
            }
        }

        double[][] qbar = sampleCovariance(z);
        if (Matrix.determinant(qbar) <= 1e-14) {
            return null;
        }

        // Reparameterize (a,b) so a in [0, A_MAX], b in [0, 1-a] are structurally guaranteed -
        // same discipline GarchEngine/EgarchEngine already use for their own constraints.
        final double A_MAX = 0.3;
        NelderMeadOptimizer.ObjectiveFunction negLogLik = u -> {
            double a = sigmoid(u[0]) * A_MAX;
            double b = sigmoid(u[1]) * (1 - a);
            return -dccLogLikelihood(z, qbar, a, b);
        };
        double[] initialUnconstrained = {invSigmoid(0.05 / A_MAX), invSigmoid(0.9)};
        double[] fitted = NelderMeadOptimizer.minimize(negLogLik, initialUnconstrained, 2000, 1e-10);
        double a = sigmoid(fitted[0]) * A_MAX;
        double b = sigmoid(fitted[1]) * (1 - a);

        double[][][] correlationPath = computeCorrelationPath(z, qbar, a, b);
        Params params = new Params(a, b, normalizeToCorrelation(qbar), garchParams);
        return new Result(params, correlationPath);
    }

    private static double dccLogLikelihood(double[][] z, double[][] qbar, double a, double b) {
        int n = z.length, k = z[0].length;
        double[][] q = qbar;
        double ll = 0;
        for (int t = 1; t < n; t++) {
            double[][] outerPrev = outerProduct(z[t - 1]);
            double[][] newQ = new double[k][k];
            for (int i = 0; i < k; i++) {
                for (int j = 0; j < k; j++) {
                    newQ[i][j] = (1 - a - b) * qbar[i][j] + a * outerPrev[i][j] + b * q[i][j];
                }
            }
            q = newQ;
            double[][] r = normalizeToCorrelation(q);
            double det = Matrix.determinant(r);
            if (det <= 1e-12) {
                return -1e18;
            }
            double[][] rInv = Matrix.invert(r);
            if (rInv == null) {
                return -1e18;
            }
            double[] rInvZ = Matrix.multiply(rInv, z[t]);
            double quad = dot(z[t], rInvZ);
            double zz = dot(z[t], z[t]);
            ll += -0.5 * (Math.log(det) + quad - zz);
        }
        return ll;
    }

    private static double[][][] computeCorrelationPath(double[][] z, double[][] qbar, double a, double b) {
        int n = z.length, k = z[0].length;
        double[][][] path = new double[n][][];
        double[][] q = qbar;
        path[0] = normalizeToCorrelation(qbar);
        for (int t = 1; t < n; t++) {
            double[][] outerPrev = outerProduct(z[t - 1]);
            double[][] newQ = new double[k][k];
            for (int i = 0; i < k; i++) {
                for (int j = 0; j < k; j++) {
                    newQ[i][j] = (1 - a - b) * qbar[i][j] + a * outerPrev[i][j] + b * q[i][j];
                }
            }
            q = newQ;
            path[t] = normalizeToCorrelation(q);
        }
        return path;
    }

    private static double[][] normalizeToCorrelation(double[][] q) {
        int k = q.length;
        double[] d = new double[k];
        for (int i = 0; i < k; i++) d[i] = Math.sqrt(Math.max(q[i][i], 1e-12));
        double[][] r = new double[k][k];
        for (int i = 0; i < k; i++) {
            for (int j = 0; j < k; j++) {
                r[i][j] = q[i][j] / (d[i] * d[j]);
            }
        }
        return r;
    }

    private static double[][] outerProduct(double[] v) {
        int k = v.length;
        double[][] out = new double[k][k];
        for (int i = 0; i < k; i++) {
            for (int j = 0; j < k; j++) {
                out[i][j] = v[i] * v[j];
            }
        }
        return out;
    }

    private static double[][] sampleCovariance(double[][] z) {
        int n = z.length, k = z[0].length;
        double[] means = new double[k];
        for (int s = 0; s < k; s++) {
            double sum = 0;
            for (int t = 0; t < n; t++) sum += z[t][s];
            means[s] = sum / n;
        }
        double[][] cov = new double[k][k];
        for (int i = 0; i < k; i++) {
            for (int j = 0; j < k; j++) {
                double sum = 0;
                for (int t = 0; t < n; t++) sum += (z[t][i] - means[i]) * (z[t][j] - means[j]);
                cov[i][j] = sum / (n - 1);
            }
        }
        return cov;
    }

    private static double[] column(double[][] matrix, int col) {
        double[] out = new double[matrix.length];
        for (int i = 0; i < matrix.length; i++) out[i] = matrix[i][col];
        return out;
    }

    private static double dot(double[] a, double[] b) {
        double s = 0;
        for (int i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
    }

    private static double sigmoid(double x) {
        return 1.0 / (1.0 + Math.exp(-x));
    }

    private static double invSigmoid(double p) {
        double clamped = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
        return Math.log(clamped / (1 - clamped));
    }
}
