package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class RidgeRegressionTest {

    @Test
    void degeneratesToPlainOlsWhenLambdaIsZero() {
        Random rnd = new Random(1);
        int n = 100;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = i * 0.1;
            y[i] = 2.0 + 3.0 * x[i][0] + rnd.nextGaussian() * 0.01;
        }
        var ridge = RidgeRegression.fit(x, y, 0.0, true);
        var ols = OlsRegression.fit(x, y, true);

        assertThat(ridge).isNotNull();
        assertThat(ridge.coefficients()[0]).isCloseTo(ols.coefficients()[0], org.assertj.core.data.Offset.offset(1e-6));
        assertThat(ridge.coefficients()[1]).isCloseTo(ols.coefficients()[1], org.assertj.core.data.Offset.offset(1e-6));
    }

    @Test
    void shrinksCoefficientsTowardZeroAsLambdaGrows() {
        Random rnd = new Random(2);
        int n = 100;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = rnd.nextGaussian();
            y[i] = 5.0 * x[i][0] + rnd.nextGaussian() * 0.5;
        }
        var lowLambda = RidgeRegression.fit(x, y, 0.01, true);
        var highLambda = RidgeRegression.fit(x, y, 1000.0, true);

        assertThat(Math.abs(highLambda.coefficients()[1])).isLessThan(Math.abs(lowLambda.coefficients()[1]));
    }

    @Test
    void returnsNullForFewerObservationsThanParameters() {
        double[][] x = { { 1.0, 2.0 } };
        double[] y = { 1.0 };
        assertThat(RidgeRegression.fit(x, y, 1.0, true)).isNull();
    }

    @Test
    void rejectsANegativeLambda() {
        double[][] x = { { 1 }, { 2 }, { 3 } };
        double[] y = { 1, 2, 3 };
        assertThat(RidgeRegression.fit(x, y, -1.0, true)).isNull();
    }
}
