package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MeanReversionZScoreEngineTest {

    @Test
    void signalsSellWhenPriceSpikesFarAboveItsRecentMean() {
        double[] closes = new double[25];
        for (int i = 0; i < 24; i++) closes[i] = 100 + Math.sin(i) * 0.5; // tight range around 100
        closes[24] = 130; // sharp spike

        var result = MeanReversionZScoreEngine.evaluate(closes, 20, 2.0);
        assertThat(result).isNotNull();
        assertThat(result.zScore()).isGreaterThan(2.0);
        assertThat(result.extremeOverbought()).isTrue();
        assertThat(result.fadeSignal()).isEqualTo("SELL");
    }

    @Test
    void signalsBuyWhenPriceCollapsesFarBelowItsRecentMean() {
        double[] closes = new double[25];
        for (int i = 0; i < 24; i++) closes[i] = 100 + Math.sin(i) * 0.5;
        closes[24] = 70;

        var result = MeanReversionZScoreEngine.evaluate(closes, 20, 2.0);
        assertThat(result.extremeOversold()).isTrue();
        assertThat(result.fadeSignal()).isEqualTo("BUY");
    }

    @Test
    void reportsNeutralWhenPriceIsWithinNormalRange() {
        double[] closes = new double[25];
        for (int i = 0; i < 25; i++) closes[i] = 100 + Math.sin(i) * 0.5;

        var result = MeanReversionZScoreEngine.evaluate(closes, 20, 2.0);
        assertThat(result.fadeSignal()).isEqualTo("NEUTRAL");
    }

    @Test
    void returnsNullRatherThanFabricatingOnAFlatDegenerateWindow() {
        double[] closes = new double[25];
        for (int i = 0; i < 25; i++) closes[i] = 100; // zero variance
        assertThat(MeanReversionZScoreEngine.evaluate(closes, 20, 2.0)).isNull();
    }
}
