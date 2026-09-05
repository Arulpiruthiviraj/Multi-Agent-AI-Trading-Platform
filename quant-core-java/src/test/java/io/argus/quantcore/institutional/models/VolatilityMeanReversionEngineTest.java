package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class VolatilityMeanReversionEngineTest {

    @Test
    void flagsVolExtremeHighWhenRecentVolatilitySpikesFarAboveItsOwnHistory() {
        Random rnd = new Random(5);
        int n = 300;
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            // Long calm history, then a sharp volatility spike only in the final few bars - kept
            // short relative to the Z-score window so the window's own mean/std is not itself
            // dominated by the spike (which would understate how extreme the latest reading is).
            double vol = i < n - 5 ? 0.001 : 0.06;
            price *= 1 + rnd.nextGaussian() * vol;
            closes[i] = price;
        }

        var result = VolatilityMeanReversionEngine.evaluate(closes, 10, 60, 2.0);
        assertThat(result).isNotNull();
        assertThat(result.volZScore()).isGreaterThan(2.0);
        assertThat(result.volExtremeHigh()).isTrue();
        assertThat(result.currentRealizedVol()).isGreaterThan(0.0);
    }

    @Test
    void reportsNoExtremeForConsistentlyStableVolatility() {
        Random rnd = new Random(7);
        int n = 200;
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price *= 1 + rnd.nextGaussian() * 0.01; // consistent vol throughout
            closes[i] = price;
        }

        var result = VolatilityMeanReversionEngine.evaluate(closes, 10, 60, 2.0);
        assertThat(result.volExtremeHigh()).isFalse();
        assertThat(result.volExtremeLow()).isFalse();
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100, 101, 99, 102 };
        assertThat(VolatilityMeanReversionEngine.evaluate(closes, 10, 60, 2.0)).isNull();
    }
}
