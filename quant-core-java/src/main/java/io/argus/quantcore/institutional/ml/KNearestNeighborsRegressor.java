package io.argus.quantcore.institutional.ml;

import java.util.Arrays;

/**
 * k-Nearest-Neighbors regression: predicts the real mean of the k closest (Euclidean distance)
 * training targets - a real, non-parametric, distance-based model, kept deliberately simple
 * (linear scan; this codebase's convention is small datasets, not a KD-tree at this scale).
 */
public final class KNearestNeighborsRegressor {

    private final double[][] xTrain;
    private final double[] yTrain;

    private KNearestNeighborsRegressor(double[][] xTrain, double[] yTrain) {
        this.xTrain = xTrain;
        this.yTrain = yTrain;
    }

    public static KNearestNeighborsRegressor fit(double[][] xTrain, double[] yTrain) {
        int n = yTrain.length;
        if (n == 0 || xTrain.length != n) {
            return null;
        }
        return new KNearestNeighborsRegressor(xTrain, yTrain);
    }

    private static double euclideanDistance(double[] a, double[] b) {
        double s = 0;
        for (int i = 0; i < a.length; i++) {
            double d = a[i] - b[i];
            s += d * d;
        }
        return Math.sqrt(s);
    }

    /** @return NaN if k is invalid (&lt;1 or &gt; training size) - never a fabricated prediction. */
    public double predict(double[] x, int k) {
        int n = yTrain.length;
        if (k < 1 || k > n) {
            return Double.NaN;
        }
        Integer[] order = new Integer[n];
        for (int i = 0; i < n; i++) order[i] = i;
        Arrays.sort(order, (a, b) -> Double.compare(euclideanDistance(xTrain[a], x), euclideanDistance(xTrain[b], x)));

        double sum = 0;
        for (int i = 0; i < k; i++) sum += yTrain[order[i]];
        return sum / k;
    }
}
