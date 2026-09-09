package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class KeltnerChannelEngineTest {

    private static double[] constant(int n, double v) {
        double[] a = new double[n];
        java.util.Arrays.fill(a, v);
        return a;
    }

    @Test
    void signalsBuyWhenCloseBreaksAboveTheUpperBand() {
        int n = 25;
        double[] highs = constant(n, 101);
        double[] lows = constant(n, 99);
        double[] closes = constant(n, 100); // tight range around 100 -> small ATR, tight bands
        closes[n - 1] = 130; // sharp breakout well beyond a tight-range 2xATR band
        highs[n - 1] = 131;

        var result = KeltnerChannelEngine.evaluate(highs, lows, closes, 20, 14);

        assertThat(result).isNotNull();
        assertThat(result.brokeAboveUpper()).isTrue();
        assertThat(result.breakoutSignal()).isEqualTo("BUY");
    }

    @Test
    void signalsSellWhenCloseBreaksBelowTheLowerBand() {
        int n = 25;
        double[] highs = constant(n, 101);
        double[] lows = constant(n, 99);
        double[] closes = constant(n, 100);
        closes[n - 1] = 70;
        lows[n - 1] = 69;

        var result = KeltnerChannelEngine.evaluate(highs, lows, closes, 20, 14);

        assertThat(result.brokeBelowLower()).isTrue();
        assertThat(result.breakoutSignal()).isEqualTo("SELL");
    }

    @Test
    void reportsNeutralWhenCloseStaysInsideTheBands() {
        int n = 25;
        double[] highs = constant(n, 101);
        double[] lows = constant(n, 99);
        double[] closes = constant(n, 100);

        var result = KeltnerChannelEngine.evaluate(highs, lows, closes, 20, 14);

        assertThat(result.breakoutSignal()).isEqualTo("NEUTRAL");
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] highs = { 101, 102 };
        double[] lows = { 99, 98 };
        double[] closes = { 100, 100 };
        assertThat(KeltnerChannelEngine.evaluate(highs, lows, closes, 20, 14)).isNull();
    }
}
