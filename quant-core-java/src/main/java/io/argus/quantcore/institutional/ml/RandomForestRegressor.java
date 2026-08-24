package io.argus.quantcore.institutional.ml;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * Random Forest (Breiman, 2001): bootstrap-sampled rows + per-split random feature subsampling
 * (both real ingredients - not just a bag of identical trees) across many
 * {@link DecisionTreeRegressor} trees, prediction is the real mean across trees.
 */
public final class RandomForestRegressor {

    private final List<DecisionTreeRegressor> trees;

    private RandomForestRegressor(List<DecisionTreeRegressor> trees) {
        this.trees = trees;
    }

    /**
     * @param numTrees             ensemble size (e.g. 100).
     * @param maxDepth             per-tree depth cap (e.g. 4).
     * @param minSamplesLeaf       per-tree leaf-size floor (e.g. 5).
     * @param maxFeaturesPerSplit  features considered per split (classic default: sqrt(k) for regression is debated - the caller decides; pass k for no subsampling).
     * @param seed                 deterministic seed for reproducible tests/backtests.
     * @return null for degenerate inputs.
     */
    public static RandomForestRegressor fit(double[][] X, double[] y, int numTrees, int maxDepth, int minSamplesLeaf, int maxFeaturesPerSplit, long seed) {
        int n = y.length;
        if (n == 0 || X.length != n || numTrees < 1) {
            return null;
        }
        Random random = new Random(seed);
        List<DecisionTreeRegressor> trees = new ArrayList<>(numTrees);
        for (int t = 0; t < numTrees; t++) {
            double[][] xb = new double[n][];
            double[] yb = new double[n];
            for (int i = 0; i < n; i++) {
                int pick = random.nextInt(n); // bootstrap: sample with replacement
                xb[i] = X[pick];
                yb[i] = y[pick];
            }
            DecisionTreeRegressor tree = DecisionTreeRegressor.fit(xb, yb, maxDepth, minSamplesLeaf, maxFeaturesPerSplit, random);
            if (tree == null) {
                return null;
            }
            trees.add(tree);
        }
        return new RandomForestRegressor(trees);
    }

    public double predict(double[] x) {
        double sum = 0;
        for (DecisionTreeRegressor tree : trees) sum += tree.predict(x);
        return sum / trees.size();
    }

    public int treeCount() {
        return trees.size();
    }
}
