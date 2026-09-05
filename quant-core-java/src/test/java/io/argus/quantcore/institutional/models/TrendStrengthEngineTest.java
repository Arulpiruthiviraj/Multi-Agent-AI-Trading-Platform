package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class TrendStrengthEngineTest {

    @Test
    void reportsAStrongUptrendWithPlusDiAboveMinusDi() {
        int n = 100;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price += 1.0; // consistent, one-directional daily range
            highs[i] = price + 0.5;
            lows[i] = price - 0.5;
            closes[i] = price;
        }

        var result = TrendStrengthEngine.evaluate(highs, lows, closes, 14);
        assertThat(result).isNotNull();
        assertThat(result.plusDI()).isGreaterThan(result.minusDI());
        assertThat(result.trendingUp()).isTrue();
        assertThat(result.adx()).isGreaterThan(TrendStrengthEngine.STRONG_TREND_THRESHOLD);
        assertThat(result.strongTrend()).isTrue();
    }

    @Test
    void reportsAStrongDowntrendWithMinusDiAbovePlusDi() {
        int n = 100;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        double price = 200;
        for (int i = 0; i < n; i++) {
            price -= 1.0;
            highs[i] = price + 0.5;
            lows[i] = price - 0.5;
            closes[i] = price;
        }

        var result = TrendStrengthEngine.evaluate(highs, lows, closes, 14);
        assertThat(result.minusDI()).isGreaterThan(result.plusDI());
        assertThat(result.trendingUp()).isFalse();
        assertThat(result.strongTrend()).isTrue();
    }

    @Test
    void reportsALowAdxForARangeBoundChoppyMarket() {
        Random rnd = new Random(11);
        int n = 100;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            // Oscillates with no persistent direction - mean-reverts around 100.
            price = 100 + Math.sin(i * 0.9) * 0.5 + (rnd.nextDouble() - 0.5) * 0.1;
            highs[i] = price + 0.3;
            lows[i] = price - 0.3;
            closes[i] = price;
        }

        var result = TrendStrengthEngine.evaluate(highs, lows, closes, 14);
        assertThat(result.adx()).isLessThan(TrendStrengthEngine.STRONG_TREND_THRESHOLD);
        assertThat(result.strongTrend()).isFalse();
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] highs = { 101, 102, 103 };
        double[] lows = { 99, 100, 101 };
        double[] closes = { 100, 101, 102 };
        assertThat(TrendStrengthEngine.evaluate(highs, lows, closes, 14)).isNull();
    }
}
