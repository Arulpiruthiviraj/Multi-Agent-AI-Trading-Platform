package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class VectorAutoregressionTest {

    @Test
    void recoversARealCrossSeriesLeadLagRelationship() {
        // Series B is driven by series A's PREVIOUS value - a real lead/lag relationship a
        // single-series AR model could never see, only VAR's cross-series lag terms can.
        Random rnd = new Random(2);
        int n = 400;
        double[][] series = new double[n][2];
        series[0][0] = rnd.nextGaussian();
        series[0][1] = rnd.nextGaussian();
        for (int t = 1; t < n; t++) {
            series[t][0] = 0.5 * series[t - 1][0] + rnd.nextGaussian() * 0.3;
            series[t][1] = 0.8 * series[t - 1][0] + rnd.nextGaussian() * 0.1; // driven by A's lag
        }

        var result = VectorAutoregression.fit(series, 1);
        assertThat(result).isNotNull();
        assertThat(result.equations()).hasSize(2);

        // Equation for series B (index 1): lag-1 coefficient on series A (index 0) should be near 0.8.
        double coeffAonB = result.equations()[1].coefficientsByLagThenSeries()[0][0];
        assertThat(coeffAonB).isCloseTo(0.8, org.assertj.core.data.Offset.offset(0.15));
    }

    @Test
    void forecastProducesOneValuePerSeries() {
        double[][] series = new double[20][3];
        Random rnd = new Random(3);
        for (int t = 0; t < 20; t++) {
            for (int s = 0; s < 3; s++) series[t][s] = rnd.nextGaussian();
        }
        var result = VectorAutoregression.fit(series, 1);
        assertThat(result).isNotNull();
        double[] forecast = result.forecastOneStep(series, 1);
        assertThat(forecast).hasSize(3);
    }

    @Test
    void returnsNullForMismatchedSeriesLengths() {
        double[][] series = { { 1, 2 }, { 3 } };
        assertThat(VectorAutoregression.fit(series, 1)).isNull();
    }

    @Test
    void returnsNullWhenThereIsNotEnoughDataForTheSystem() {
        double[][] series = { { 1, 2 }, { 3, 4 } };
        assertThat(VectorAutoregression.fit(series, 1)).isNull();
    }
}
