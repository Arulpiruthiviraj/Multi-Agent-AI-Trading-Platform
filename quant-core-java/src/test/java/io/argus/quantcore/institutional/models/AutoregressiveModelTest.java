package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class AutoregressiveModelTest {

    @Test
    void recoversARealKnownAr1Coefficient() {
        Random rnd = new Random(1);
        int n = 500;
        double phi = 0.7;
        double[] series = new double[n];
        series[0] = rnd.nextGaussian();
        for (int t = 1; t < n; t++) {
            series[t] = phi * series[t - 1] + rnd.nextGaussian() * 0.5;
        }
        var params = AutoregressiveModel.fit(series, 1);
        assertThat(params).isNotNull();
        assertThat(params.lagCoefficients()[0]).isCloseTo(phi, org.assertj.core.data.Offset.offset(0.1));
    }

    @Test
    void forecastsUsingTheRealFittedCoefficients() {
        double[] series = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 }; // near-perfect AR(1) with phi=1 (random walk-ish trend)
        var params = AutoregressiveModel.fit(series, 1);
        double forecast = params.forecastOneStep(series);
        // Should predict continuing the upward pattern, not something wildly off.
        assertThat(forecast).isBetween(8.0, 13.0);
    }

    @Test
    void returnsNullForAnOrderThatLeavesNoDegreesOfFreedom() {
        double[] series = { 1, 2, 3 };
        assertThat(AutoregressiveModel.fit(series, 5)).isNull();
    }
}
