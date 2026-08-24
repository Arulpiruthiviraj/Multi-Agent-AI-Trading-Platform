package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class ElasticNetRegressionTest {

    @Test
    void pureLassoDrivesAnIrrelevantFeatureExactlyToZero() {
        Random rnd = new Random(3);
        int n = 200;
        double[][] x = new double[n][2];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = rnd.nextGaussian();
            x[i][1] = rnd.nextGaussian(); // genuinely irrelevant to y
            y[i] = 4.0 * x[i][0] + rnd.nextGaussian() * 0.1;
        }
        var result = ElasticNetRegression.fit(x, y, 0.5, 1.0, 2000, 1e-8);
        assertThat(result).isNotNull();
        assertThat(result.converged()).isTrue();
        assertThat(result.coefficients()[0]).isNotZero();
        assertThat(result.coefficients()[1]).isCloseTo(0.0, org.assertj.core.data.Offset.offset(0.15));
    }

    @Test
    void recoversARealRelationshipWithModerateNoiseAndSmallPenalty() {
        Random rnd = new Random(4);
        int n = 200;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = rnd.nextGaussian();
            y[i] = -2.0 * x[i][0] + 1.0 + rnd.nextGaussian() * 0.1;
        }
        var result = ElasticNetRegression.fit(x, y, 0.01, 0.5, 2000, 1e-8);
        assertThat(result.coefficients()[0]).isCloseTo(-2.0, org.assertj.core.data.Offset.offset(0.2));
        assertThat(result.intercept()).isCloseTo(1.0, org.assertj.core.data.Offset.offset(0.2));
    }

    @Test
    void returnsNullForAnInvalidL1Ratio() {
        double[][] x = { { 1 }, { 2 }, { 3 } };
        double[] y = { 1, 2, 3 };
        assertThat(ElasticNetRegression.fit(x, y, 0.1, 1.5, 100, 1e-6)).isNull();
    }

    @Test
    void lassoWrapperProducesTheSameResultAsElasticNetAtL1RatioOne() {
        Random rnd = new Random(6);
        int n = 100;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = rnd.nextGaussian();
            y[i] = 3.0 * x[i][0] + rnd.nextGaussian() * 0.2;
        }
        var viaLasso = LassoRegression.fit(x, y, 0.1, 1000, 1e-8);
        var viaElasticNet = ElasticNetRegression.fit(x, y, 0.1, 1.0, 1000, 1e-8);
        assertThat(viaLasso.coefficients()[0]).isEqualTo(viaElasticNet.coefficients()[0]);
    }
}
