package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class VolumeSignalEngineTest {

    @Test
    void detectsAVolumeBreakoutWhenTheLatestBarFarExceedsAverageVolume() {
        int n = 25;
        double[] closes = new double[n];
        double[] volumes = new double[n];
        for (int i = 0; i < n - 1; i++) {
            closes[i] = 100;
            volumes[i] = 1_000_000;
        }
        closes[n - 1] = 100;
        volumes[n - 1] = 5_000_000; // 5x average

        var result = VolumeSignalEngine.evaluate(closes, volumes, 20, 10, 2.0);
        assertThat(result).isNotNull();
        assertThat(result.relativeVolume()).isCloseTo(5.0, org.assertj.core.data.Offset.offset(0.1));
        assertThat(result.volumeBreakout()).isTrue();
    }

    @Test
    void flagsBearishDivergenceWhenPriceRisesOnDecliningVolume() {
        int n = 25;
        double[] closes = new double[n];
        double[] volumes = new double[n];
        for (int i = 0; i < n; i++) closes[i] = 100;
        // Price rallies over the final 10 bars...
        for (int i = n - 10; i < n; i++) closes[i] = 100 + (i - (n - 10)) * 2;
        // ...while volume is declining across that same window (recent half lower than prior half).
        for (int i = 0; i < n; i++) volumes[i] = 1_000_000;
        for (int i = n - 10; i < n - 5; i++) volumes[i] = 900_000;
        for (int i = n - 5; i < n; i++) volumes[i] = 400_000;

        var result = VolumeSignalEngine.evaluate(closes, volumes, 20, 10, 2.0);
        assertThat(result.priceChangePct()).isPositive();
        assertThat(result.volumeChangePct()).isNegative();
        assertThat(result.bearishDivergence()).isTrue();
        assertThat(result.bullishDivergence()).isFalse();
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100, 101 };
        double[] volumes = { 1000, 1000 };
        assertThat(VolumeSignalEngine.evaluate(closes, volumes, 20, 10, 2.0)).isNull();
    }

    @Test
    void rejectsAnOddDivergenceWindowRatherThanSilentlyMiscomputingTheHalves() {
        double[] closes = new double[30];
        double[] volumes = new double[30];
        for (int i = 0; i < 30; i++) { closes[i] = 100; volumes[i] = 1000; }
        assertThat(VolumeSignalEngine.evaluate(closes, volumes, 20, 9, 2.0)).isNull();
    }
}
