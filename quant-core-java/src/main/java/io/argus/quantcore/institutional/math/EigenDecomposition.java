package io.argus.quantcore.institutional.math;

import java.util.Arrays;
import java.util.Comparator;

/**
 * Eigenvalues/eigenvectors of a real SYMMETRIC matrix via the classical cyclic Jacobi rotation
 * method (Jacobi, 1846; see Golub &amp; Van Loan, "Matrix Computations", Ch. 8.4). Always converges
 * for symmetric input, which is exactly what a real covariance/correlation matrix is - the
 * building block PrincipalComponentAnalysis needs. Not a general (non-symmetric) eigensolver.
 */
public final class EigenDecomposition {

    private EigenDecomposition() {
    }

    /** eigenvalues[i] pairs with eigenvectors[.][i] (column i); sorted descending by eigenvalue. */
    public record Result(double[] eigenvalues, double[][] eigenvectors) {
    }

    private static final double DEFAULT_TOLERANCE = 1e-10;
    private static final int MAX_SWEEPS = 100;

    /** @return null if the matrix isn't square, or isn't symmetric within a loose tolerance. */
    public static Result decompose(double[][] symmetricMatrix) {
        int n = symmetricMatrix.length;
        for (double[] row : symmetricMatrix) {
            if (row.length != n) return null;
        }
        for (int i = 0; i < n; i++) {
            for (int j = i + 1; j < n; j++) {
                if (Math.abs(symmetricMatrix[i][j] - symmetricMatrix[j][i]) > 1e-6 * (1 + Math.abs(symmetricMatrix[i][j]))) {
                    return null;
                }
            }
        }

        double[][] a = new double[n][n];
        for (int i = 0; i < n; i++) a[i] = symmetricMatrix[i].clone();
        double[][] v = new double[n][n];
        for (int i = 0; i < n; i++) v[i][i] = 1.0;

        for (int sweep = 0; sweep < MAX_SWEEPS; sweep++) {
            double offDiagonalSumSq = 0;
            for (int p = 0; p < n; p++) {
                for (int q = p + 1; q < n; q++) {
                    offDiagonalSumSq += a[p][q] * a[p][q];
                }
            }
            if (offDiagonalSumSq < DEFAULT_TOLERANCE) {
                break;
            }
            for (int p = 0; p < n; p++) {
                for (int q = p + 1; q < n; q++) {
                    if (Math.abs(a[p][q]) < 1e-15) continue;
                    double theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
                    double t = Math.signum(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                    if (theta == 0) t = 1.0;
                    double c = 1.0 / Math.sqrt(t * t + 1);
                    double s = t * c;

                    double app = a[p][p], aqq = a[q][q], apq = a[p][q];
                    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
                    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
                    a[p][q] = 0;
                    a[q][p] = 0;
                    for (int i = 0; i < n; i++) {
                        if (i == p || i == q) continue;
                        double aip = a[i][p], aiq = a[i][q];
                        a[i][p] = c * aip - s * aiq;
                        a[p][i] = a[i][p];
                        a[i][q] = s * aip + c * aiq;
                        a[q][i] = a[i][q];
                    }
                    for (int i = 0; i < n; i++) {
                        double vip = v[i][p], viq = v[i][q];
                        v[i][p] = c * vip - s * viq;
                        v[i][q] = s * vip + c * viq;
                    }
                }
            }
        }

        double[] eigenvalues = new double[n];
        for (int i = 0; i < n; i++) eigenvalues[i] = a[i][i];

        Integer[] order = new Integer[n];
        for (int i = 0; i < n; i++) order[i] = i;
        Arrays.sort(order, Comparator.comparingDouble((Integer i) -> eigenvalues[i]).reversed());

        double[] sortedValues = new double[n];
        double[][] sortedVectors = new double[n][n];
        for (int newIdx = 0; newIdx < n; newIdx++) {
            int oldIdx = order[newIdx];
            sortedValues[newIdx] = eigenvalues[oldIdx];
            for (int row = 0; row < n; row++) {
                sortedVectors[row][newIdx] = v[row][oldIdx];
            }
        }

        return new Result(sortedValues, sortedVectors);
    }
}
