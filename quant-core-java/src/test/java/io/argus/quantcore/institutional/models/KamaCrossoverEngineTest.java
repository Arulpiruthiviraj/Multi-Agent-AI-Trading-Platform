package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class KamaCrossoverEngineTest {

    @Test
    void signalsBuyOnAGoldenCross_atSomePointWhileAFlatMarketStartsTrendingUpStrongly() {
        // Flat for a long stretch (KAMA and the slow reference SMA converge together near the
        // flat level), then a strong, clean uptrend - KAMA (fast-reacting once ER rises) should,
        // at some bar during the uptrend, cross above the slower reference SMA (which keeps
        // lagging behind). The exact crossing bar depends on the filters' own lag, so scan the
        // whole trending window for it rather than assuming it lands on one specific bar.
        double[] closes = new double[140];
        for (int i = 0; i < 60; i++) closes[i] = 100;
        for (int i = 60; i < 140; i++) closes[i] = 100 + (i - 59) * 2.0;

        boolean sawGoldenCross = false;
        for (int len = 61; len <= closes.length; len++) {
            double[] window = java.util.Arrays.copyOfRange(closes, 0, len);
            var result = KamaCrossoverEngine.evaluate(window, 50, 12, 5, 50);
            if (result != null && result.crossSignal().equals("BUY")) {
                sawGoldenCross = true;
                break;
            }
        }
        assertThat(sawGoldenCross).isTrue();
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100, 101, 102 };
        assertThat(KamaCrossoverEngine.evaluate(closes, 50, 12, 5, 50)).isNull();
    }

    @Test
    void reportsNeutralWhenNoCrossHasJustHappened() {
        double[] closes = new double[80];
        for (int i = 0; i < closes.length; i++) closes[i] = 100; // perfectly flat - both lines converge, never cross

        var result = KamaCrossoverEngine.evaluate(closes, 50, 12, 5, 50);

        assertThat(result.crossSignal()).isEqualTo("NEUTRAL");
    }
}
