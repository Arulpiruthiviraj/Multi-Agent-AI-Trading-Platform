package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class LogisticRegressionTest {

    @Test
    void learnsARealSeparableBoundaryAndPredictsHighProbabilityForPositiveExamples() {
        Random rnd = new Random(42);
        int n = 300;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            double feature = rnd.nextGaussian() * 2;
            x[i][0] = feature;
            y[i] = feature > 0 ? 1.0 : 0.0; // cleanly separable by the sign of the feature
        }
        var result = LogisticRegression.fit(x, y, 0.5, 5000, 1e-10);
        assertThat(result).isNotNull();
        assertThat(result.coefficients()[0]).isPositive(); // higher feature -> higher probability of class 1

        double probHighFeature = LogisticRegression.predictProbability(result.intercept(), result.coefficients(), new double[] { 5.0 });
        double probLowFeature = LogisticRegression.predictProbability(result.intercept(), result.coefficients(), new double[] { -5.0 });
        assertThat(probHighFeature).isGreaterThan(0.9);
        assertThat(probLowFeature).isLessThan(0.1);
    }

    @Test
    void logLossDecreasesAsTrainingProgressesTowardConvergence() {
        Random rnd = new Random(8);
        int n = 200;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            double feature = rnd.nextGaussian();
            x[i][0] = feature;
            y[i] = feature + rnd.nextGaussian() * 0.3 > 0 ? 1.0 : 0.0;
        }
        var fewIterations = LogisticRegression.fit(x, y, 0.1, 2, 1e-12);
        var manyIterations = LogisticRegression.fit(x, y, 0.1, 500, 1e-12);
        assertThat(manyIterations.finalLogLoss()).isLessThan(fewIterations.finalLogLoss());
    }

    @Test
    void rejectsALabelOutsideZeroOrOne() {
        double[][] x = { { 1 }, { 2 } };
        double[] y = { 0.0, 2.0 };
        assertThat(LogisticRegression.fit(x, y, 0.1, 100, 1e-6)).isNull();
    }
}
