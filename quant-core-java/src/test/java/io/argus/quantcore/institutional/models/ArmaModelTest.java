package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class ArmaModelTest {

    @Test
    void recoversRoughlyTheRealArAndMaCoefficientsOfAKnownArma11Process() {
        Random rnd = new Random(5);
        int n = 3000; // Hannan-Rissanen is a real but noisier estimator than full MLE - needs more data
        double phi = 0.6, theta = 0.4;
        double[] e = new double[n];
        double[] y = new double[n];
        e[0] = rnd.nextGaussian() * 0.5;
        y[0] = e[0];
        for (int t = 1; t < n; t++) {
            e[t] = rnd.nextGaussian() * 0.5;
            y[t] = phi * y[t - 1] + e[t] + theta * e[t - 1];
        }

        var params = ArmaModel.fit(y, 1, 1, 25);
        assertThat(params).isNotNull();
        assertThat(params.arCoefficients()[0]).isCloseTo(phi, org.assertj.core.data.Offset.offset(0.2));
        assertThat(params.maCoefficients()[0]).isCloseTo(theta, org.assertj.core.data.Offset.offset(0.25));
    }

    @Test
    void supportsPureArWithMaOrderZero() {
        Random rnd = new Random(6);
        int n = 500;
        double phi = 0.5;
        double[] y = new double[n];
        y[0] = rnd.nextGaussian();
        for (int t = 1; t < n; t++) y[t] = phi * y[t - 1] + rnd.nextGaussian() * 0.3;

        var params = ArmaModel.fit(y, 1, 0, 10);
        assertThat(params).isNotNull();
        assertThat(params.maCoefficients()).isEmpty();
        assertThat(params.arCoefficients()[0]).isCloseTo(phi, org.assertj.core.data.Offset.offset(0.15));
    }

    @Test
    void returnsNullWhenBothOrdersAreZero() {
        double[] y = { 1, 2, 3, 4, 5 };
        assertThat(ArmaModel.fit(y, 0, 0, 10)).isNull();
    }

    @Test
    void returnsNullWhenLongArOrderIsTooSmallForTheRequestedOrders() {
        double[] y = new double[100];
        for (int i = 0; i < 100; i++) y[i] = i;
        assertThat(ArmaModel.fit(y, 3, 3, 4)).isNull(); // longArOrder must be >= p+q+1 = 7
    }
}
