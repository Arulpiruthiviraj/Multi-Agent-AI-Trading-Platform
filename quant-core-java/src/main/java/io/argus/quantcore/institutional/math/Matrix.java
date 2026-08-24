package io.argus.quantcore.institutional.math;

/**
 * Minimal dense-matrix support for the institutional math package (OLS design-matrix solve,
 * EWMA covariance updates). Intentionally small and hand-rolled rather than a new Maven
 * dependency, matching the "no heavy frameworks" line already drawn in pom.xml for the rest of
 * this module — these are all tiny matrices (at most a handful of factors / assets), never a
 * candidate for a BLAS-backed library.
 */
public final class Matrix {

    private Matrix() {
    }

    /** C = A * B. */
    public static double[][] multiply(double[][] a, double[][] b) {
        int n = a.length, m = a[0].length, p = b[0].length;
        if (b.length != m) {
            throw new IllegalArgumentException("Inner dimensions must match: " + m + " vs " + b.length);
        }
        double[][] c = new double[n][p];
        for (int i = 0; i < n; i++) {
            for (int k = 0; k < m; k++) {
                double aik = a[i][k];
                if (aik == 0) continue;
                for (int j = 0; j < p; j++) {
                    c[i][j] += aik * b[k][j];
                }
            }
        }
        return c;
    }

    public static double[] multiply(double[][] a, double[] v) {
        int n = a.length, m = a[0].length;
        if (v.length != m) {
            throw new IllegalArgumentException("Dimension mismatch: " + m + " vs " + v.length);
        }
        double[] out = new double[n];
        for (int i = 0; i < n; i++) {
            double s = 0;
            for (int j = 0; j < m; j++) {
                s += a[i][j] * v[j];
            }
            out[i] = s;
        }
        return out;
    }

    public static double[][] transpose(double[][] a) {
        int n = a.length, m = a[0].length;
        double[][] t = new double[m][n];
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < m; j++) {
                t[j][i] = a[i][j];
            }
        }
        return t;
    }

    /**
     * Gauss-Jordan inversion with partial pivoting. Returns {@code null} (never a garbage
     * near-singular result) if the matrix is singular past a small tolerance — callers (OLS)
     * must treat that as "not enough independent variation to fit," not fall back to a guess.
     */
    public static double[][] invert(double[][] a) {
        int n = a.length;
        double[][] work = new double[n][2 * n];
        for (int i = 0; i < n; i++) {
            System.arraycopy(a[i], 0, work[i], 0, n);
            work[i][n + i] = 1.0;
        }
        for (int col = 0; col < n; col++) {
            int pivot = col;
            double best = Math.abs(work[col][col]);
            for (int row = col + 1; row < n; row++) {
                double v = Math.abs(work[row][col]);
                if (v > best) {
                    best = v;
                    pivot = row;
                }
            }
            if (best < 1e-12) {
                return null;
            }
            double[] tmp = work[col];
            work[col] = work[pivot];
            work[pivot] = tmp;

            double pivotVal = work[col][col];
            for (int j = 0; j < 2 * n; j++) {
                work[col][j] /= pivotVal;
            }
            for (int row = 0; row < n; row++) {
                if (row == col) continue;
                double factor = work[row][col];
                if (factor == 0) continue;
                for (int j = 0; j < 2 * n; j++) {
                    work[row][j] -= factor * work[col][j];
                }
            }
        }
        double[][] inv = new double[n][n];
        for (int i = 0; i < n; i++) {
            System.arraycopy(work[i], n, inv[i], 0, n);
        }
        return inv;
    }
}
