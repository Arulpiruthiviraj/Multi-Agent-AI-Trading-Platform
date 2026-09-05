package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class StatArbEngineTest {

    @Test
    void detectsCointegrationForATrueCointegratedPair() {
        // priceB is a random walk; priceA = 2*priceB + stationary AR(1) noise -> A and B are
        // cointegrated by construction (Engle-Granger residual = the stationary noise term).
        Random rnd = new Random(11);
        int n = 400;
        double[] priceB = new double[n];
        double[] priceA = new double[n];
        double noise = 0;
        priceB[0] = 100;
        priceA[0] = 2 * priceB[0] + noise;
        for (int t = 1; t < n; t++) {
            priceB[t] = priceB[t - 1] + rnd.nextGaussian() * 0.5;
            noise = 0.4 * noise + rnd.nextGaussian() * 0.3; // stationary AR(1) spread
            priceA[t] = 2 * priceB[t] + noise;
        }

        StatArbEngine.PairResult result = StatArbEngine.evaluatePair(priceA, priceB, 60);
        assertThat(result).isNotNull();
        assertThat(result.hedgeRatio()).isCloseTo(2.0, org.assertj.core.data.Offset.offset(0.2));
        assertThat(result.cointegrated()).isTrue();
        assertThat(result.halfLifeBars()).isNotNull();
        assertThat(result.halfLifeBars()).isGreaterThan(0);
    }

    @Test
    void doesNotDetectCointegrationForTwoIndependentRandomWalks() {
        Random rnd = new Random(99);
        int n = 400;
        double[] priceA = new double[n];
        double[] priceB = new double[n];
        priceA[0] = 100;
        priceB[0] = 50;
        for (int t = 1; t < n; t++) {
            priceA[t] = priceA[t - 1] + rnd.nextGaussian();
            priceB[t] = priceB[t - 1] + rnd.nextGaussian();
        }

        StatArbEngine.PairResult result = StatArbEngine.evaluatePair(priceA, priceB, 60);
        assertThat(result).isNotNull();
        assertThat(result.cointegrated()).isFalse();
    }

    @Test
    void returnsNullForMismatchedSeriesLengths() {
        assertThat(StatArbEngine.evaluatePair(new double[]{1, 2, 3}, new double[]{1, 2}, 10)).isNull();
    }
}
