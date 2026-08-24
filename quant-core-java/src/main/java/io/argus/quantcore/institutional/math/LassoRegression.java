package io.argus.quantcore.institutional.math;

/**
 * Lasso (pure L1-penalized regression) - a thin, explicit entry point over
 * {@link ElasticNetRegression} at l1Ratio=1.0, rather than a second coordinate-descent
 * implementation. Kept as its own class because "Lasso" is itself a named item in the strategy
 * catalog this engine targets, not because the math differs from ElasticNetRegression's general case.
 */
public final class LassoRegression {

    private LassoRegression() {
    }

    public static ElasticNetRegression.Result fit(double[][] predictors, double[] y, double lambda, int maxIterations, double tolerance) {
        return ElasticNetRegression.fit(predictors, y, lambda, 1.0, maxIterations, tolerance);
    }
}
