package io.argus.quantcore.institutional.math;

/**
 * Binary logistic regression via batch gradient descent on the real log-loss (cross-entropy)
 * objective - textbook algorithm, no shortcuts. Useful for classification-style quant questions
 * (e.g. "does this feature pattern predict an up day") as distinct from OLS/Ridge/Lasso/ElasticNet,
 * which are all real-valued regression, not classification.
 */
public final class LogisticRegression {

    private LogisticRegression() {
    }

    public record Result(double intercept, double[] coefficients, int iterations, boolean converged, double finalLogLoss) {
    }

    private static final double EPS = 1e-12;

    private static double sigmoid(double z) {
        return 1.0 / (1.0 + Math.exp(-z));
    }

    /**
     * @param predictors    n x k matrix, NOT including an intercept column.
     * @param yBinary       length-n labels, each exactly 0.0 or 1.0.
     * @param learningRate  gradient-descent step size (e.g. 0.1).
     * @param maxIterations sweep cap (e.g. 1000).
     * @param tolerance     stop once the log-loss improvement between sweeps is below this (e.g. 1e-8).
     * @return null for degenerate inputs (mismatched lengths, a label outside {0,1}, empty data).
     */
    public static Result fit(double[][] predictors, double[] yBinary, double learningRate, int maxIterations, double tolerance) {
        int n = yBinary.length;
        if (n == 0 || predictors.length != n || learningRate <= 0 || maxIterations < 1) {
            return null;
        }
        for (double y : yBinary) {
            if (y != 0.0 && y != 1.0) {
                return null;
            }
        }
        int k = predictors[0].length;

        double intercept = 0;
        double[] beta = new double[k];
        double prevLoss = Double.POSITIVE_INFINITY;
        double loss = 0;
        int iter = 0;
        boolean converged = false;

        for (; iter < maxIterations; iter++) {
            double gradIntercept = 0;
            double[] gradBeta = new double[k];
            loss = 0;
            for (int i = 0; i < n; i++) {
                double z = intercept;
                for (int j = 0; j < k; j++) z += predictors[i][j] * beta[j];
                double p = sigmoid(z);
                double error = p - yBinary[i];
                gradIntercept += error;
                for (int j = 0; j < k; j++) gradBeta[j] += error * predictors[i][j];

                double pClamped = Math.min(Math.max(p, EPS), 1 - EPS);
                loss -= yBinary[i] * Math.log(pClamped) + (1 - yBinary[i]) * Math.log(1 - pClamped);
            }
            loss /= n;
            intercept -= learningRate * (gradIntercept / n);
            for (int j = 0; j < k; j++) beta[j] -= learningRate * (gradBeta[j] / n);

            if (Math.abs(prevLoss - loss) < tolerance) {
                converged = true;
                iter++;
                break;
            }
            prevLoss = loss;
        }

        return new Result(intercept, beta, iter, converged, loss);
    }

    public static double predictProbability(double intercept, double[] coefficients, double[] x) {
        double z = intercept;
        for (int j = 0; j < coefficients.length; j++) z += coefficients[j] * x[j];
        return sigmoid(z);
    }
}
