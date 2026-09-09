package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MoneyFlowIndexEngineTest {

    private static double[] constantVolume(int n, double v) {
        double[] a = new double[n];
        java.util.Arrays.fill(a, v);
        return a;
    }

    @Test
    void isAt100_theHonestRatioLimit_whenThereIsZeroNegativeMoneyFlowInTheWindow() {
        int n = 20;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n; i++) {
            closes[i] = 100 + i; // strictly rising every single day - no negative money flow at all
            highs[i] = closes[i] + 1;
            lows[i] = closes[i] - 1;
        }
        double[] volumes = constantVolume(n, 1000);

        var result = MoneyFlowIndexEngine.evaluate(highs, lows, closes, volumes, 14);

        assertThat(result).isNotNull();
        assertThat(result.mfi()).isEqualTo(100.0);
        assertThat(result.overbought()).isTrue();
        assertThat(result.signal()).isEqualTo("SELL");
    }

    @Test
    void signalsBuyWhenOversold() {
        int n = 20;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n; i++) {
            closes[i] = 200 - i; // strictly falling every day - no positive money flow at all
            highs[i] = closes[i] + 1;
            lows[i] = closes[i] - 1;
        }
        double[] volumes = constantVolume(n, 1000);

        var result = MoneyFlowIndexEngine.evaluate(highs, lows, closes, volumes, 14);

        assertThat(result.mfi()).isEqualTo(0.0);
        assertThat(result.oversold()).isTrue();
        assertThat(result.signal()).isEqualTo("BUY");
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] highs = { 101, 102 };
        double[] lows = { 99, 100 };
        double[] closes = { 100, 101 };
        double[] volumes = { 1000, 1100 };
        assertThat(MoneyFlowIndexEngine.evaluate(highs, lows, closes, volumes, 14)).isNull();
    }
}
