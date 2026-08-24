package io.argus.quantcore.institutional.ml;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * Gradient Boosting for squared-error regression (Friedman, "Greedy Function Approximation: A
 * Gradient Boosting Machine", 2001): starts from the real mean of y, then sequentially fits a
 * shallow {@link DecisionTreeRegressor} to the CURRENT residuals (the true negative gradient of
 * squared-error loss) and adds it in at a shrunk learning rate - the standard algorithm XGBoost/
 * LightGBM are optimized implementations of, not a different one.
 */
public final class GradientBoostingRegressor {

    private final double initialPrediction;
    private final List<DecisionTreeRegressor> trees;
    private final double learningRate;

    private GradientBoostingRegressor(double initialPrediction, List<DecisionTreeRegressor> trees, double learningRate) {
        this.initialPrediction = initialPrediction;
        this.trees = trees;
        this.learningRate = learningRate;
    }

    /**
     * @param numTrees       boosting rounds (e.g. 100).
     * @param maxDepth       per-tree depth cap - deliberately shallow for boosting (e.g. 2-3).
     * @param minSamplesLeaf per-tree leaf-size floor.
     * @param learningRate   shrinkage applied to every tree's contribution (e.g. 0.1).
     * @return null for degenerate inputs.
     */
    public static GradientBoostingRegressor fit(double[][] X, double[] y, int numTrees, int maxDepth, int minSamplesLeaf, double learningRate) {
        int n = y.length;
        if (n == 0 || X.length != n || numTrees < 1 || learningRate <= 0) {
            return null;
        }
        double initial = 0;
        for (double v : y) initial += v;
        initial /= n;

        double[] predictions = new double[n];
        java.util.Arrays.fill(predictions, initial);

        List<DecisionTreeRegressor> trees = new ArrayList<>(numTrees);
        int k = X[0].length;
        Random random = new Random(0);
        for (int t = 0; t < numTrees; t++) {
            double[] residuals = new double[n];
            for (int i = 0; i < n; i++) residuals[i] = y[i] - predictions[i];

            DecisionTreeRegressor tree = DecisionTreeRegressor.fit(X, residuals, maxDepth, minSamplesLeaf, k, random);
            if (tree == null) {
                return null;
            }
            trees.add(tree);
            for (int i = 0; i < n; i++) {
                predictions[i] += learningRate * tree.predict(X[i]);
            }
        }

        return new GradientBoostingRegressor(initial, trees, learningRate);
    }

    public double predict(double[] x) {
        double p = initialPrediction;
        for (DecisionTreeRegressor tree : trees) {
            p += learningRate * tree.predict(x);
        }
        return p;
    }

    public int treeCount() {
        return trees.size();
    }
}
