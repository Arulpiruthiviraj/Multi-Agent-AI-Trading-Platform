package io.argus.quantcore.institutional.ml;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * CART-style regression tree (Breiman, Friedman, Olshen &amp; Stone, "Classification and
 * Regression Trees", 1984): recursively splits on the feature/threshold that minimizes the sum of
 * squared error across the two children, until max depth or a minimum leaf size is reached. Leaf
 * prediction is the real mean of training targets that reached it - no smoothing, no invention.
 *
 * The single tree-building/prediction implementation both RandomForestRegressor (bagged, with
 * per-split feature subsampling) and GradientBoostingRegressor (sequential, fit to residuals)
 * build on - one authoritative tree implementation, not three drifting copies.
 */
public final class DecisionTreeRegressor {

    private final Node root;

    private DecisionTreeRegressor(Node root) {
        this.root = root;
    }

    private static final class Node {
        int featureIndex = -1;
        double threshold;
        double value;
        Node left;
        Node right;

        boolean isLeaf() {
            return left == null;
        }
    }

    /**
     * @param X                  n x k feature matrix.
     * @param y                  length-n targets.
     * @param maxDepth           tree depth cap (e.g. 4).
     * @param minSamplesLeaf     minimum training rows a leaf (and thus either side of a split) must have (e.g. 5).
     * @param maxFeaturesPerSplit if less than k, each split considers a random subset of this many
     *                            features (the real "Random Forest" ingredient, distinct from a
     *                            plain bagged-trees ensemble); pass k itself for a plain CART tree.
     * @param random             source of randomness for feature subsampling (ignored if maxFeaturesPerSplit &gt;= k).
     * @return null for degenerate inputs (mismatched lengths, empty data, invalid parameters).
     */
    public static DecisionTreeRegressor fit(double[][] X, double[] y, int maxDepth, int minSamplesLeaf, int maxFeaturesPerSplit, Random random) {
        int n = y.length;
        if (n == 0 || X.length != n || maxDepth < 1 || minSamplesLeaf < 1) {
            return null;
        }
        int k = X[0].length;
        if (k == 0 || maxFeaturesPerSplit < 1) {
            return null;
        }
        int[] allIndices = new int[n];
        for (int i = 0; i < n; i++) allIndices[i] = i;
        Node root = buildNode(X, y, allIndices, 0, maxDepth, minSamplesLeaf, Math.min(maxFeaturesPerSplit, k), random);
        return new DecisionTreeRegressor(root);
    }

    public static DecisionTreeRegressor fit(double[][] X, double[] y, int maxDepth, int minSamplesLeaf) {
        return fit(X, y, maxDepth, minSamplesLeaf, X.length > 0 ? X[0].length : 1, new Random(0));
    }

    private static double mean(double[] y, int[] idx) {
        double s = 0;
        for (int i : idx) s += y[i];
        return s / idx.length;
    }

    private static double sse(double[] y, int[] idx) {
        double m = mean(y, idx);
        double s = 0;
        for (int i : idx) {
            double d = y[i] - m;
            s += d * d;
        }
        return s;
    }

    private static Node buildNode(double[][] X, double[] y, int[] idx, int depth, int maxDepth, int minSamplesLeaf, int maxFeaturesPerSplit, Random random) {
        Node leaf = new Node();
        leaf.value = mean(y, idx);
        if (depth >= maxDepth || idx.length < 2 * minSamplesLeaf) {
            return leaf;
        }

        int k = X[0].length;
        int[] candidateFeatures = sampleFeatures(k, maxFeaturesPerSplit, random);

        int bestFeature = -1;
        double bestThreshold = 0;
        double bestSse = sse(y, idx);
        int[] bestLeft = null, bestRight = null;

        for (int f : candidateFeatures) {
            Integer[] order = new Integer[idx.length];
            for (int i = 0; i < idx.length; i++) order[i] = idx[i];
            java.util.Arrays.sort(order, (a, b) -> Double.compare(X[a][f], X[b][f]));

            for (int splitPos = minSamplesLeaf; splitPos <= idx.length - minSamplesLeaf; splitPos++) {
                double leftMax = X[order[splitPos - 1]][f];
                double rightMin = X[order[splitPos]][f];
                if (leftMax == rightMin) continue; // cannot split between equal values
                double threshold = (leftMax + rightMin) / 2.0;

                int[] left = new int[splitPos];
                int[] right = new int[idx.length - splitPos];
                for (int i = 0; i < splitPos; i++) left[i] = order[i];
                for (int i = splitPos; i < idx.length; i++) right[i - splitPos] = order[i];

                double splitSse = sse(y, left) + sse(y, right);
                if (splitSse < bestSse) {
                    bestSse = splitSse;
                    bestFeature = f;
                    bestThreshold = threshold;
                    bestLeft = left;
                    bestRight = right;
                }
            }
        }

        if (bestFeature < 0) {
            return leaf;
        }
        Node node = new Node();
        node.featureIndex = bestFeature;
        node.threshold = bestThreshold;
        node.left = buildNode(X, y, bestLeft, depth + 1, maxDepth, minSamplesLeaf, maxFeaturesPerSplit, random);
        node.right = buildNode(X, y, bestRight, depth + 1, maxDepth, minSamplesLeaf, maxFeaturesPerSplit, random);
        return node;
    }

    private static int[] sampleFeatures(int k, int count, Random random) {
        if (count >= k) {
            int[] all = new int[k];
            for (int i = 0; i < k; i++) all[i] = i;
            return all;
        }
        List<Integer> pool = new ArrayList<>();
        for (int i = 0; i < k; i++) pool.add(i);
        java.util.Collections.shuffle(pool, random);
        int[] chosen = new int[count];
        for (int i = 0; i < count; i++) chosen[i] = pool.get(i);
        return chosen;
    }

    public double predict(double[] x) {
        Node n = root;
        while (!n.isLeaf()) {
            n = x[n.featureIndex] <= n.threshold ? n.left : n.right;
        }
        return n.value;
    }
}
