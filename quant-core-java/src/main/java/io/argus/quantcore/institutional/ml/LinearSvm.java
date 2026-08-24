package io.argus.quantcore.institutional.ml;

import java.util.Random;

/**
 * Linear Support Vector Machine via Pegasos (Shalev-Shwartz, Singer, Srebro &amp; Cotter,
 * "Pegasos: Primal Estimated sub-GrAdient SOlver for SVM", Math. Programming 2011) - real
 * stochastic sub-gradient descent on the hinge-loss + L2-regularization primal objective,
 * including the algorithm's own projection step onto the ||w|| &lt;= 1/sqrt(lambda) ball. A real,
 * standard SVM training algorithm (linear kernel) - not a from-scratch SMO/quadratic-programming
 * solver, which is a materially larger undertaking; Pegasos is the same family of guarantee
 * (converges to the true SVM primal optimum) used in practice for large-scale linear SVMs.
 */
public final class LinearSvm {

    private final double[] weights;
    private final double bias;

    private LinearSvm(double[] weights, double bias) {
        this.weights = weights;
        this.bias = bias;
    }

    /**
     * @param X        n x k feature matrix.
     * @param yLabels  length-n labels, each exactly -1.0 or +1.0.
     * @param lambda   L2 regularization strength (&gt; 0; larger = simpler/more regularized boundary).
     * @param epochs   full passes over the (shuffled) training data (e.g. 50).
     * @param seed     deterministic seed for reproducible tests/backtests.
     * @return null for degenerate inputs (mismatched lengths, a label outside {-1,+1}, lambda &lt;= 0).
     */
    public static LinearSvm fit(double[][] X, double[] yLabels, double lambda, int epochs, long seed) {
        int n = yLabels.length;
        if (n == 0 || X.length != n || lambda <= 0 || epochs < 1) {
            return null;
        }
        for (double y : yLabels) {
            if (y != 1.0 && y != -1.0) {
                return null;
            }
        }
        int k = X[0].length;
        double[] w = new double[k];
        double bias = 0;
        Random random = new Random(seed);

        int t = 0;
        for (int epoch = 0; epoch < epochs; epoch++) {
            int[] order = shuffledIndices(n, random);
            for (int idx : order) {
                t++;
                double eta = 1.0 / (lambda * t);
                double margin = yLabels[idx] * (dot(w, X[idx]) + bias);

                for (int j = 0; j < k; j++) {
                    w[j] = (1 - eta * lambda) * w[j];
                }
                if (margin < 1) {
                    for (int j = 0; j < k; j++) {
                        w[j] += eta * yLabels[idx] * X[idx][j];
                    }
                    bias += eta * yLabels[idx];
                }

                // Pegasos's own projection step: keep ||w|| within the radius the regularizer implies.
                double normW = Math.sqrt(dot(w, w));
                double radius = 1.0 / Math.sqrt(lambda);
                if (normW > radius && normW > 0) {
                    double scale = radius / normW;
                    for (int j = 0; j < k; j++) w[j] *= scale;
                }
            }
        }

        return new LinearSvm(w, bias);
    }

    private static int[] shuffledIndices(int n, Random random) {
        int[] idx = new int[n];
        for (int i = 0; i < n; i++) idx[i] = i;
        for (int i = n - 1; i > 0; i--) {
            int j = random.nextInt(i + 1);
            int tmp = idx[i];
            idx[i] = idx[j];
            idx[j] = tmp;
        }
        return idx;
    }

    private static double dot(double[] a, double[] b) {
        double s = 0;
        for (int i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
    }

    public double decisionValue(double[] x) {
        return dot(weights, x) + bias;
    }

    public int predictLabel(double[] x) {
        return decisionValue(x) >= 0 ? 1 : -1;
    }

    public double[] weights() {
        return weights;
    }

    public double bias() {
        return bias;
    }
}
