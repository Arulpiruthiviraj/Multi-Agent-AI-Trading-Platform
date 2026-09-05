package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class DonchianChannelEngineTest {

    @Test
    void detectsAnUpsideBreakoutWhenTheCurrentCloseExceedsThePriorNBarHigh() {
        int n = 25;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n - 1; i++) {
            highs[i] = 101;
            lows[i] = 99;
            closes[i] = 100;
        }
        // Current bar breaks well above the prior 20-bar high of 101.
        highs[n - 1] = 110;
        lows[n - 1] = 105;
        closes[n - 1] = 108;

        var result = DonchianChannelEngine.evaluate(highs, lows, closes, 20);
        assertThat(result).isNotNull();
        assertThat(result.upperChannel()).isEqualTo(101.0);
        assertThat(result.lowerChannel()).isEqualTo(99.0);
        assertThat(result.breakoutUp()).isTrue();
        assertThat(result.breakoutDown()).isFalse();
    }

    @Test
    void detectsADownsideBreakoutSymmetrically() {
        int n = 25;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n - 1; i++) {
            highs[i] = 101;
            lows[i] = 99;
            closes[i] = 100;
        }
        highs[n - 1] = 95;
        lows[n - 1] = 90;
        closes[n - 1] = 92;

        var result = DonchianChannelEngine.evaluate(highs, lows, closes, 20);
        assertThat(result.breakoutDown()).isTrue();
        assertThat(result.breakoutUp()).isFalse();
    }

    @Test
    void reportsNoBreakoutWhenTheCloseStaysInsideThePriorChannel() {
        int n = 25;
        double[] highs = new double[n];
        double[] lows = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n; i++) {
            highs[i] = 101;
            lows[i] = 99;
            closes[i] = 100;
        }
        var result = DonchianChannelEngine.evaluate(highs, lows, closes, 20);
        assertThat(result.breakoutUp()).isFalse();
        assertThat(result.breakoutDown()).isFalse();
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] highs = { 101, 102 };
        double[] lows = { 99, 98 };
        double[] closes = { 100, 100 };
        assertThat(DonchianChannelEngine.evaluate(highs, lows, closes, 20)).isNull();
    }
}
