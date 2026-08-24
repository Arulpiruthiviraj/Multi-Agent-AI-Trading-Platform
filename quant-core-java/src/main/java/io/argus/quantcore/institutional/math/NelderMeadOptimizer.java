package io.argus.quantcore.institutional.math;

import java.util.Arrays;
import java.util.Comparator;

/**
 * Generic gradient-free Nelder-Mead simplex minimizer. GARCH(1,1) MLE is the only current caller
 * (io.argus.quantcore.institutional.models.GarchModel) - reparameterizing the constrained
 * (omega&gt;0, alpha,beta&gt;=0, alpha+beta&lt;1) GARCH parameter space into an unconstrained one and
 * minimizing negative log-likelihood here avoids a numerical-optimization library dependency for
 * what is, in this codebase, a single 3-parameter problem.
 */
public final class NelderMeadOptimizer {

    @FunctionalInterface
    public interface ObjectiveFunction {
        double evaluate(double[] x);
    }

    private NelderMeadOptimizer() {
    }

    public static double[] minimize(ObjectiveFunction f, double[] initial, int maxIterations, double tolerance) {
        int n = initial.length;
        double[][] simplex = new double[n + 1][n];
        double[] values = new double[n + 1];

        simplex[0] = initial.clone();
        for (int i = 0; i < n; i++) {
            double[] point = initial.clone();
            double step = point[i] == 0 ? 0.05 : point[i] * 0.05;
            point[i] += step;
            simplex[i + 1] = point;
        }
        for (int i = 0; i <= n; i++) {
            values[i] = f.evaluate(simplex[i]);
        }

        double alpha = 1.0, gamma = 2.0, rho = 0.5, sigma = 0.5;

        for (int iter = 0; iter < maxIterations; iter++) {
            Integer[] order = sortedIndices(values);
            double[][] sortedSimplex = new double[n + 1][];
            double[] sortedValues = new double[n + 1];
            for (int i = 0; i <= n; i++) {
                sortedSimplex[i] = simplex[order[i]];
                sortedValues[i] = values[order[i]];
            }
            simplex = sortedSimplex;
            values = sortedValues;

            if (Math.abs(values[n] - values[0]) < tolerance) {
                break;
            }

            double[] centroid = new double[n];
            for (int i = 0; i < n; i++) {
                for (int j = 0; j < n; j++) {
                    centroid[j] += simplex[i][j];
                }
            }
            for (int j = 0; j < n; j++) centroid[j] /= n;

            double[] worst = simplex[n];
            double[] reflected = pointAt(centroid, worst, alpha);
            double reflectedValue = f.evaluate(reflected);

            if (reflectedValue < values[0]) {
                double[] expanded = pointAt(centroid, worst, gamma);
                double expandedValue = f.evaluate(expanded);
                if (expandedValue < reflectedValue) {
                    simplex[n] = expanded;
                    values[n] = expandedValue;
                } else {
                    simplex[n] = reflected;
                    values[n] = reflectedValue;
                }
                continue;
            }
            if (reflectedValue < values[n - 1]) {
                simplex[n] = reflected;
                values[n] = reflectedValue;
                continue;
            }

            double[] contracted = pointAt(centroid, worst, -rho);
            double contractedValue = f.evaluate(contracted);
            if (contractedValue < values[n]) {
                simplex[n] = contracted;
                values[n] = contractedValue;
                continue;
            }

            for (int i = 1; i <= n; i++) {
                for (int j = 0; j < n; j++) {
                    simplex[i][j] = simplex[0][j] + sigma * (simplex[i][j] - simplex[0][j]);
                }
                values[i] = f.evaluate(simplex[i]);
            }
        }

        Integer[] finalOrder = sortedIndices(values);
        return simplex[finalOrder[0]];
    }

    /** centroid + factor*(centroid - worst). */
    private static double[] pointAt(double[] centroid, double[] worst, double factor) {
        int n = centroid.length;
        double[] out = new double[n];
        for (int i = 0; i < n; i++) {
            out[i] = centroid[i] + factor * (centroid[i] - worst[i]);
        }
        return out;
    }

    private static Integer[] sortedIndices(double[] values) {
        Integer[] idx = new Integer[values.length];
        for (int i = 0; i < values.length; i++) idx[i] = i;
        Arrays.sort(idx, Comparator.comparingDouble(i -> values[i]));
        return idx;
    }
}
