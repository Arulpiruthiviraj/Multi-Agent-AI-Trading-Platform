package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class IntradayGapReversalEngineTest {

    @Test
    void flagsALargeUpGapAsAFadeSellCandidate() {
        int n = 25;
        double[] opens = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n - 1; i++) {
            opens[i] = 100;
            closes[i] = 100;
        }
        // Final session gaps up 5% at the open, then drifts flat into the close.
        opens[n - 1] = 105;
        closes[n - 1] = 105;

        var result = IntradayGapReversalEngine.evaluate(opens, closes, 20, 0.02);
        assertThat(result).isNotNull();
        assertThat(result.gapPct()).isCloseTo(0.05, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.extremeGap()).isTrue();
        assertThat(result.gapFadeSignal()).isEqualTo("SELL");
    }

    @Test
    void flagsALargeDownGapAsAFadeBuyCandidate() {
        int n = 25;
        double[] opens = new double[n];
        double[] closes = new double[n];
        for (int i = 0; i < n - 1; i++) {
            opens[i] = 100;
            closes[i] = 100;
        }
        opens[n - 1] = 95;
        closes[n - 1] = 95;

        var result = IntradayGapReversalEngine.evaluate(opens, closes, 20, 0.02);
        assertThat(result.gapFadeSignal()).isEqualTo("BUY");
    }

    @Test
    void computesARealOvernightReversalRateAcrossTheWindow() {
        // Every session: gaps up 1%, then fully reverses intraday back down 1% (a perfectly
        // reversing pattern) - overnightReversalRate must be 1.0, not a guess.
        int n = 25;
        double[] opens = new double[n];
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            opens[i] = price * 1.01;
            closes[i] = price;
            price = closes[i];
        }

        var result = IntradayGapReversalEngine.evaluate(opens, closes, 20, 0.5);
        assertThat(result.overnightReversalRate()).isEqualTo(1.0);
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] opens = { 100, 101 };
        double[] closes = { 100, 100 };
        assertThat(IntradayGapReversalEngine.evaluate(opens, closes, 20, 0.02)).isNull();
    }
}
