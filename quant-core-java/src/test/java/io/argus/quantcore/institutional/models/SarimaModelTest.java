package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class SarimaModelTest {

    @Test
    void recoversARealSeasonalArPatternAtTheCorrectPeriod() {
        // A pure seasonal AR(1)_4 process: y_t = 0.6*y_{t-4} + noise - a real, deliberate seasonal
        // dependency at period 4 that a non-seasonal model has no term to capture at all.
        Random rnd = new Random(20);
        int n = 400;
        double seasonalPhi = 0.6;
        double[] y = new double[n];
        for (int t = 0; t < 4; t++) y[t] = rnd.nextGaussian() * 0.5;
        for (int t = 4; t < n; t++) y[t] = seasonalPhi * y[t - 4] + rnd.nextGaussian() * 0.3;

        var params = SarimaModel.fit(y, 0, 0, 0, 1, 0, 0, 4, 20);
        assertThat(params).isNotNull();
        assertThat(params.seasonalArCoefficients()[0]).isCloseTo(seasonalPhi, org.assertj.core.data.Offset.offset(0.2));
    }

    @Test
    void forecastProducesARealFiniteNumberForASeasonalPlusTrendSeries() {
        Random rnd = new Random(21);
        int n = 200;
        double[] y = new double[n];
        double level = 100;
        for (int t = 0; t < n; t++) {
            level += 0.1; // slow drift
            double seasonalBump = (t % 4 == 0) ? 2.0 : 0.0; // real, deterministic period-4 pattern
            y[t] = level + seasonalBump + rnd.nextGaussian() * 0.2;
        }
        var params = SarimaModel.fit(y, 1, 1, 0, 1, 0, 0, 4, 25);
        assertThat(params).isNotNull();
        double forecast = params.forecastOneStep(y);
        assertThat(Double.isFinite(forecast)).isTrue();
        assertThat(forecast).isCloseTo(y[n - 1], org.assertj.core.data.Offset.offset(20.0));
    }

    @Test
    void returnsNullWhenLongArOrderIsTooSmallForTheRequestedNonSeasonalOrders() {
        double[] series = new double[100];
        for (int i = 0; i < 100; i++) series[i] = i;
        assertThat(SarimaModel.fit(series, 3, 0, 3, 0, 0, 0, 4, 4)).isNull(); // needs >= p+q+1 = 7
    }

    @Test
    void returnsNullWhenDifferencingLeavesTooLittleData() {
        double[] series = { 1, 2, 3 };
        assertThat(SarimaModel.fit(series, 1, 1, 0, 1, 1, 0, 4, 10)).isNull();
    }

    @Test
    void returnsNullForANonPositiveSeasonalPeriod() {
        double[] series = new double[50];
        for (int i = 0; i < 50; i++) series[i] = i;
        assertThat(SarimaModel.fit(series, 1, 0, 0, 1, 0, 0, 0, 10)).isNull();
    }
}
