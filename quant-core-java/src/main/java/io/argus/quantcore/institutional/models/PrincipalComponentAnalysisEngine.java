package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.EigenDecomposition;

/**
 * Principal Component Analysis over a real sample covariance matrix (mean-centered features,
 * standard N-1 covariance), via the real Jacobi eigendecomposition in
 * {@link io.argus.quantcore.institutional.math.EigenDecomposition} - no shortcuts, no randomized
 * approximation. Explained-variance ratios are the real eigenvalue proportions, not invented.
 */
public final class PrincipalComponentAnalysisEngine {

    private PrincipalComponentAnalysisEngine() {
    }

    public record Result(
        double[] explainedVarianceRatio,
        double[][] componentLoadings, // componentLoadings[feature][component]
        double[][] projectedScores    // projectedScores[observation][component]
    ) {
    }

    /**
     * @param data n observations (rows) x k features (columns), NOT pre-centered - centering is
     *             done internally.
     * @return null if there are fewer than 2 observations, fewer than 2 features, or the
     *         covariance matrix's eigendecomposition fails (should only happen for pathological input).
     */
    public static Result evaluate(double[][] data) {
        int n = data.length;
        if (n < 2) return null;
        int k = data[0].length;
        for (double[] row : data) {
            if (row.length != k) return null;
        }
        if (k < 1) return null;

        double[] means = new double[k];
        for (int j = 0; j < k; j++) {
            double s = 0;
            for (int i = 0; i < n; i++) s += data[i][j];
            means[j] = s / n;
        }
        double[][] centered = new double[n][k];
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < k; j++) {
                centered[i][j] = data[i][j] - means[j];
            }
        }

        double[][] cov = new double[k][k];
        for (int a = 0; a < k; a++) {
            for (int b = a; b < k; b++) {
                double s = 0;
                for (int i = 0; i < n; i++) s += centered[i][a] * centered[i][b];
                double v = s / (n - 1);
                cov[a][b] = v;
                cov[b][a] = v;
            }
        }

        EigenDecomposition.Result eig = EigenDecomposition.decompose(cov);
        if (eig == null) return null;

        double totalVariance = 0;
        for (double ev : eig.eigenvalues()) totalVariance += Math.max(ev, 0);
        double[] explainedRatio = new double[k];
        for (int c = 0; c < k; c++) {
            explainedRatio[c] = totalVariance > 0 ? Math.max(eig.eigenvalues()[c], 0) / totalVariance : 0;
        }

        double[][] scores = new double[n][k];
        for (int i = 0; i < n; i++) {
            for (int c = 0; c < k; c++) {
                double s = 0;
                for (int j = 0; j < k; j++) s += centered[i][j] * eig.eigenvectors()[j][c];
                scores[i][c] = s;
            }
        }

        return new Result(explainedRatio, eig.eigenvectors(), scores);
    }
}
