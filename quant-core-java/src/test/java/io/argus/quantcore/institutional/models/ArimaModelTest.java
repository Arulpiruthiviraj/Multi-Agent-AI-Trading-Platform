package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class ArimaModelTest {

    @Test
    void fitsARealIntegratedSeriesAndForecastsNearTheLastLevel() {
        // Build a real I(1) series: cumulative sum of a mean-reverting AR(1) innovation process -
        // ARIMA(1,1,0) should difference back to something close to that AR(1) process.
        Random rnd = new Random(7);
        int n = 300;
        double phi = 0.4;
        double[] innovations = new double[n];
        innovations[0] = rnd.nextGaussian() * 0.5;
        for (int t = 1; t < n; t++) innovations[t] = phi * innovations[t - 1] + rnd.nextGaussian() * 0.3;

        double[] levels = new double[n];
        levels[0] = 100;
        for (int t = 1; t < n; t++) levels[t] = levels[t - 1] + innovations[t];

        var params = ArimaModel.fit(levels, 1, 1, 0, 15);
        assertThat(params).isNotNull();
        assertThat(params.armaParams().arCoefficients()[0]).isCloseTo(phi, org.assertj.core.data.Offset.offset(0.25));

        double forecast = params.forecastOneStep(levels);
        // A one-step-ahead forecast for a near-random-walk level series should stay close to the
        // last observed level, not jump to something wildly different.
        assertThat(forecast).isCloseTo(levels[n - 1], org.assertj.core.data.Offset.offset(Math.abs(levels[n - 1]) * 0.1 + 5));
    }

    @Test
    void reducesToPlainArmaWhenDIsZero() {
        double[] series = new double[200];
        Random rnd = new Random(8);
        series[0] = rnd.nextGaussian();
        for (int t = 1; t < 200; t++) series[t] = 0.5 * series[t - 1] + rnd.nextGaussian() * 0.2;

        var arimaParams = ArimaModel.fit(series, 1, 0, 0, 10);
        var armaParams = ArmaModel.fit(series, 1, 0, 10);
        assertThat(arimaParams.armaParams().arCoefficients()[0]).isEqualTo(armaParams.arCoefficients()[0]);
    }

    @Test
    void returnsNullForANegativeDifferencingOrder() {
        double[] series = { 1, 2, 3, 4, 5 };
        assertThat(ArimaModel.fit(series, 1, -1, 0, 5)).isNull();
    }

    @Test
    void returnsNullWhenDifferencingLeavesTooLittleData() {
        double[] series = { 1, 2 };
        assertThat(ArimaModel.fit(series, 1, 1, 0, 5)).isNull();
    }
}
