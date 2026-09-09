package io.argus.quantcore.indicators;

import io.argus.quantcore.institutional.math.Matrix;

/**
 * Hodrick-Prescott filter (a.k.a. the Whittaker-Henderson method) - Hodrick &amp; Prescott, "Postwar
 * U.S. Business Cycles: An Empirical Investigation," J. Money, Credit and Banking, 1997. Decomposes
 * a series S(t) into a low-frequency trend S*(t) and high-frequency noise by minimizing
 * sum[S(t)-S*(t)]^2 + lambda * sum[S*(t+1)-2S*(t)+S*(t-1)]^2, solved in closed form as
 * (I + lambda D'D) S* = S where D is the second-difference operator - a real linear system, not an
 * iterative approximation. Reuses the existing dense Matrix.invert/multiply utilities rather than a
 * new banded solver; series lengths this is meant for (a few hundred points of monthly data, per the
 * paper's own convention) make the O(T^3) dense solve trivial.
 */
public final class HodrickPrescottFilter {

    private HodrickPrescottFilter() {
    }

    /**
     * @param series chronological values, T &gt;= 4 (the second-difference operator needs at least
     *               one interior point).
     * @param lambda smoothing parameter. The paper offers no universal value; a common convention
     *               for monthly data (frequency n=12) is 100 * n^2 = 14400 - callers must supply
     *               it explicitly, this class won't default it for them.
     * @return the trend component S*(t), same length as {@code series}; {@code null} if T &lt; 4 or
     *         lambda is not positive.
     */
    public static double[] trend(double[] series, double lambda) {
        int t = series.length;
        if (t < 4 || lambda <= 0) {
            return null;
        }

        // D is (T-2) x T: row i (0-indexed) has [1, -2, 1] at columns i, i+1, i+2.
        double[][] d = new double[t - 2][t];
        for (int i = 0; i < t - 2; i++) {
            d[i][i] = 1.0;
            d[i][i + 1] = -2.0;
            d[i][i + 2] = 1.0;
        }
        double[][] dTd = Matrix.multiply(Matrix.transpose(d), d);

        double[][] system = new double[t][t];
        for (int i = 0; i < t; i++) {
            for (int j = 0; j < t; j++) {
                system[i][j] = (i == j ? 1.0 : 0.0) + lambda * dTd[i][j];
            }
        }

        double[][] inv = Matrix.invert(system);
        if (inv == null) {
            return null;
        }
        return Matrix.multiply(inv, series);
    }

    /** Paper's own commonly-cited convention for monthly data: lambda = 100 * 12^2 = 14400. */
    public static double[] trend(double[] series) {
        return trend(series, 14400.0);
    }
}
