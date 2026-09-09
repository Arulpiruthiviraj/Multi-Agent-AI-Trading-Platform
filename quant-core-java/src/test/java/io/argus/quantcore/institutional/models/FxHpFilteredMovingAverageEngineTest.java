package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class FxHpFilteredMovingAverageEngineTest {

    @Test
    void signalsBuy_onACleanSustainedUptrend() {
        double[] spotRates = new double[40];
        for (int i = 0; i < spotRates.length; i++) {
            spotRates[i] = 1.10 + i * 0.003;
        }

        var result = FxHpFilteredMovingAverageEngine.evaluate(spotRates, 100.0, 3, 10);

        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("BUY");
        assertThat(result.maFast()).isGreaterThan(result.maSlow());
    }

    @Test
    void signalsSell_onACleanSustainedDowntrend() {
        double[] spotRates = new double[40];
        for (int i = 0; i < spotRates.length; i++) {
            spotRates[i] = 1.50 - i * 0.003;
        }

        var result = FxHpFilteredMovingAverageEngine.evaluate(spotRates, 100.0, 3, 10);

        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("SELL");
    }

    @Test
    void returnsNullRatherThanFabricating_whenThereIsNotEnoughHistoryForTheSlowerMa() {
        double[] spotRates = new double[5];
        for (int i = 0; i < spotRates.length; i++) spotRates[i] = 1.10 + i * 0.01;

        assertThat(FxHpFilteredMovingAverageEngine.evaluate(spotRates, 100.0, 3, 10)).isNull();
    }

    @Test
    void returnsNull_whenFastPeriodIsNotStrictlyLessThanSlowPeriod() {
        double[] spotRates = new double[40];
        for (int i = 0; i < spotRates.length; i++) spotRates[i] = 1.10 + i * 0.01;

        assertThat(FxHpFilteredMovingAverageEngine.evaluate(spotRates, 100.0, 10, 10)).isNull();
    }

    @Test
    void defaultOverload_usesTheConventionalMonthlyLambdaOf14400() {
        double[] spotRates = new double[40];
        for (int i = 0; i < spotRates.length; i++) spotRates[i] = 1.10 + i * 0.003;

        var withDefaults = FxHpFilteredMovingAverageEngine.evaluate(spotRates, 3, 10);
        var withExplicit = FxHpFilteredMovingAverageEngine.evaluate(spotRates, 14400.0, 3, 10);

        assertThat(withDefaults).isEqualTo(withExplicit);
    }
}
