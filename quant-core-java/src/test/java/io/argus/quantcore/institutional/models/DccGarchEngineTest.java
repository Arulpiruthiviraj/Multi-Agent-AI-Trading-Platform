package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class DccGarchEngineTest {

    @Test
    void recoversARealPositiveUnconditionalCorrelationForCommonFactorDrivenSeries() {
        Random rnd = new Random(30);
        int n = 400;
        double[][] returns = new double[n][2];
        for (int t = 0; t < n; t++) {
            double commonFactor = rnd.nextGaussian() * 0.01;
            returns[t][0] = commonFactor + rnd.nextGaussian() * 0.003;
            returns[t][1] = commonFactor + rnd.nextGaussian() * 0.003; // shares the same real common factor
        }

        var result = DccGarchEngine.fit(returns);
        assertThat(result).isNotNull();
        assertThat(result.params().unconditionalCorrelation()[0][1]).isGreaterThan(0.5);
        assertThat(result.params().a()).isBetween(0.0, 0.3);
        assertThat(result.params().b()).isBetween(0.0, 1.0);
        assertThat(result.params().a() + result.params().b()).isLessThan(1.0);
    }

    @Test
    void correlationPathHasOneRealCorrelationMatrixPerObservation() {
        Random rnd = new Random(31);
        int n = 100;
        double[][] returns = new double[n][2];
        for (int t = 0; t < n; t++) {
            returns[t][0] = rnd.nextGaussian() * 0.01;
            returns[t][1] = rnd.nextGaussian() * 0.01;
        }
        var result = DccGarchEngine.fit(returns);
        assertThat(result).isNotNull();
        assertThat(result.correlationPath().length).isEqualTo(n);
        for (double[][] r : result.correlationPath()) {
            assertThat(r).hasDimensions(2, 2);
            assertThat(r[0][0]).isCloseTo(1.0, org.assertj.core.data.Offset.offset(0.05)); // real correlation matrix diagonal
        }
    }

    @Test
    void returnsNullForASingleSeries() {
        double[][] returns = new double[100][1];
        assertThat(DccGarchEngine.fit(returns)).isNull();
    }

    @Test
    void returnsNullWhenAnIndividualSeriesHasTooLittleDataForItsOwnGarchFit() {
        double[][] returns = new double[5][2];
        assertThat(DccGarchEngine.fit(returns)).isNull();
    }
}
