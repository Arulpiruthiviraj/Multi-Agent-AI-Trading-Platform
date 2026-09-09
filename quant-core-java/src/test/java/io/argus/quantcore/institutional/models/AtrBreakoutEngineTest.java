package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AtrBreakoutEngineTest {

    private static double[] constant(int n, double v) {
        double[] a = new double[n];
        java.util.Arrays.fill(a, v);
        return a;
    }

    @Test
    void signalsBuyWhenCloseClearsThePriorCloseByMoreThanTheAtrMultiple() {
        int n = 20;
        double[] highs = constant(n, 101);
        double[] lows = constant(n, 99);
        double[] closes = constant(n, 100); // tight range -> small ATR
        closes[n - 1] = 130; // sharp move well beyond a tight-range ATR multiple
        highs[n - 1] = 131;

        var result = AtrBreakoutEngine.evaluate(highs, lows, closes, 1.5, 14);

        assertThat(result).isNotNull();
        assertThat(result.breakoutSignal()).isEqualTo("BUY");
    }

    @Test
    void signalsSellWhenCloseClearsThePriorCloseDownwardByMoreThanTheAtrMultiple() {
        int n = 20;
        double[] highs = constant(n, 101);
        double[] lows = constant(n, 99);
        double[] closes = constant(n, 100);
        closes[n - 1] = 70;
        lows[n - 1] = 69;

        var result = AtrBreakoutEngine.evaluate(highs, lows, closes, 1.5, 14);

        assertThat(result.breakoutSignal()).isEqualTo("SELL");
    }

    @Test
    void reportsNeutralForAnOrdinaryDayWithinTheAtrBand() {
        int n = 20;
        double[] highs = constant(n, 101);
        double[] lows = constant(n, 99);
        double[] closes = constant(n, 100);

        var result = AtrBreakoutEngine.evaluate(highs, lows, closes, 1.5, 14);

        assertThat(result.breakoutSignal()).isEqualTo("NEUTRAL");
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] highs = { 101, 102 };
        double[] lows = { 99, 98 };
        double[] closes = { 100, 100 };
        assertThat(AtrBreakoutEngine.evaluate(highs, lows, closes, 1.5, 14)).isNull();
    }
}
