package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class StochasticOscillatorEngineTest {

    @Test
    void reportsOverboughtWhenTheCloseSitsAtTheTopOfItsRecentRange() {
        int n = 20;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n; i++) {
            highs[i] = 110;
            lows[i] = 90;
            closes[i] = 109; // consistently near the top of the range
        }
        var result = StochasticOscillatorEngine.evaluate(highs, lows, closes, 14, 3);
        assertThat(result).isNotNull();
        assertThat(result.percentK()).isGreaterThan(90.0);
        assertThat(result.overbought()).isTrue();
        assertThat(result.oversold()).isFalse();
    }

    @Test
    void reportsOversoldWhenTheCloseSitsAtTheBottomOfItsRecentRange() {
        int n = 20;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n; i++) {
            highs[i] = 110;
            lows[i] = 90;
            closes[i] = 91;
        }
        var result = StochasticOscillatorEngine.evaluate(highs, lows, closes, 14, 3);
        assertThat(result.oversold()).isTrue();
        assertThat(result.overbought()).isFalse();
    }

    @Test
    void neverDivideByZeroOnADegenerateFlatRange() {
        int n = 20;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n; i++) {
            highs[i] = 100;
            lows[i] = 100;
            closes[i] = 100;
        }
        var result = StochasticOscillatorEngine.evaluate(highs, lows, closes, 14, 3);
        assertThat(result.percentK()).isEqualTo(50.0);
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] highs = { 101, 102 };
        double[] lows = { 99, 98 };
        double[] closes = { 100, 100 };
        assertThat(StochasticOscillatorEngine.evaluate(highs, lows, closes, 14, 3)).isNull();
    }
}
