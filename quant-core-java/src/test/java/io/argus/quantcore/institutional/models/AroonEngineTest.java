package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AroonEngineTest {

    @Test
    void aroonUpIs100WhenTheHighestHighIsTheMostRecentBar() {
        int period = 10;
        double[] highs = new double[period + 3];
        double[] lows = new double[period + 3];
        for (int i = 0; i < highs.length; i++) {
            highs[i] = 100 + i; // strictly rising highs - most recent bar is always the highest
            lows[i] = 90 + i;
        }

        var result = AroonEngine.evaluate(highs, lows, period);

        assertThat(result).isNotNull();
        assertThat(result.aroonUp()).isEqualTo(100.0);
    }

    @Test
    void aroonDownIs100WhenTheLowestLowIsTheMostRecentBar() {
        int period = 10;
        double[] highs = new double[period + 3];
        double[] lows = new double[period + 3];
        for (int i = 0; i < highs.length; i++) {
            highs[i] = 100 - i;
            lows[i] = 90 - i; // strictly falling lows - most recent bar is always the lowest
        }

        var result = AroonEngine.evaluate(highs, lows, period);

        assertThat(result.aroonDown()).isEqualTo(100.0);
    }

    @Test
    void signalsBuyOnABullishCross_whenAFreshHighEmergesAfterADowntrend() {
        int period = 10;
        // Falling for a while (AroonDown dominant), then one sharp new high right at the end.
        double[] highs = new double[16];
        double[] lows = new double[16];
        for (int i = 0; i < 15; i++) {
            highs[i] = 100 - i;
            lows[i] = 90 - i;
        }
        highs[15] = 200; // fresh high well above everything before it
        lows[15] = 190;

        var result = AroonEngine.evaluate(highs, lows, period);

        assertThat(result.crossSignal()).isEqualTo("BUY");
        assertThat(result.aroonUp()).isGreaterThan(result.aroonDown());
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] highs = { 100, 101 };
        double[] lows = { 90, 91 };
        assertThat(AroonEngine.evaluate(highs, lows, 25)).isNull();
    }
}
