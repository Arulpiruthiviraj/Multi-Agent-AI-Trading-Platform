package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class OlsRegressionTest {

    @Test
    void recoversExactCoefficientsForANoiselessLinearRelationship() {
        int n = 20;
        double[][] x = new double[n][1];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = i;
            y[i] = 2.0 * i + 1.0; // y = 2x + 1, exact
        }
        OlsRegression.Result r = OlsRegression.fit(x, y, true);
        assertThat(r).isNotNull();
        assertThat(r.coefficients()[0]).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(r.coefficients()[1]).isCloseTo(2.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(r.rSquared()).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void fitsMultivariateRegression() {
        int n = 30;
        double[][] x = new double[n][2];
        double[] y = new double[n];
        java.util.Random rnd = new java.util.Random(7);
        for (int i = 0; i < n; i++) {
            x[i][0] = i;
            x[i][1] = rnd.nextDouble() * 10;
            y[i] = 3.0 + 1.5 * x[i][0] - 0.5 * x[i][1];
        }
        OlsRegression.Result r = OlsRegression.fit(x, y, true);
        assertThat(r).isNotNull();
        assertThat(r.coefficients()[0]).isCloseTo(3.0, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(r.coefficients()[1]).isCloseTo(1.5, org.assertj.core.data.Offset.offset(1e-6));
        assertThat(r.coefficients()[2]).isCloseTo(-0.5, org.assertj.core.data.Offset.offset(1e-6));
    }

    @Test
    void returnsNullWhenObservationsFewerThanParameters() {
        double[][] x = {{1, 2}};
        double[] y = {5};
        assertThat(OlsRegression.fit(x, y, true)).isNull();
    }

    @Test
    void returnsNullForCollinearPredictors() {
        int n = 10;
        double[][] x = new double[n][2];
        double[] y = new double[n];
        for (int i = 0; i < n; i++) {
            x[i][0] = i;
            x[i][1] = 2 * i; // exactly collinear with column 0
            y[i] = i;
        }
        assertThat(OlsRegression.fit(x, y, true)).isNull();
    }
}
