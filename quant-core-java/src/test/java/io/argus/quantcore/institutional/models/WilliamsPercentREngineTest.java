package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class WilliamsPercentREngineTest {

    @Test
    void isZero_maximallyOverbought_whenCloseEqualsTheHighestHigh() {
        int n = 20;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n; i++) {
            highs[i] = 110;
            lows[i] = 90;
            closes[i] = 100;
        }
        closes[n - 1] = 110; // closes exactly at the period's highest high

        var result = WilliamsPercentREngine.evaluate(highs, lows, closes, 14);

        assertThat(result).isNotNull();
        assertThat(result.percentR()).isEqualTo(0.0);
        assertThat(result.overbought()).isTrue();
        assertThat(result.signal()).isEqualTo("SELL");
    }

    @Test
    void isNegative100_maximallyOversold_whenCloseEqualsTheLowestLow() {
        int n = 20;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n; i++) {
            highs[i] = 110;
            lows[i] = 90;
            closes[i] = 100;
        }
        closes[n - 1] = 90;

        var result = WilliamsPercentREngine.evaluate(highs, lows, closes, 14);

        assertThat(result.percentR()).isEqualTo(-100.0);
        assertThat(result.oversold()).isTrue();
        assertThat(result.signal()).isEqualTo("BUY");
    }

    @Test
    void returnsNullRatherThanDivideByZeroForAPerfectlyFlatRange() {
        int n = 20;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        java.util.Arrays.fill(highs, 100);
        java.util.Arrays.fill(lows, 100);
        java.util.Arrays.fill(closes, 100);

        assertThat(WilliamsPercentREngine.evaluate(highs, lows, closes, 14)).isNull();
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] highs = { 101, 102 };
        double[] lows = { 99, 98 };
        double[] closes = { 100, 100 };
        assertThat(WilliamsPercentREngine.evaluate(highs, lows, closes, 14)).isNull();
    }
}
