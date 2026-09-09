package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class BollingerMeanReversionEngineTest {

    @Test
    void signalsBuyWhenCloseIsAtOrBelowTheLowerBand() {
        double[] closes = new double[21];
        for (int i = 0; i < 20; i++) closes[i] = 100 + Math.sin(i) * 0.5; // tight range around 100
        closes[20] = 80; // sharp drop, well beyond a 2-std-dev band on such a tight prior range

        var result = BollingerMeanReversionEngine.evaluate(closes);
        assertThat(result).isNotNull();
        assertThat(result.atOrBeyondLowerBand()).isTrue();
        assertThat(result.fadeSignal()).isEqualTo("BUY");
    }

    @Test
    void signalsSellWhenCloseIsAtOrAboveTheUpperBand() {
        double[] closes = new double[21];
        for (int i = 0; i < 20; i++) closes[i] = 100 + Math.sin(i) * 0.5;
        closes[20] = 120;

        var result = BollingerMeanReversionEngine.evaluate(closes);
        assertThat(result.atOrBeyondUpperBand()).isTrue();
        assertThat(result.fadeSignal()).isEqualTo("SELL");
    }

    @Test
    void reportsNeutralWhenCloseIsWithinTheBands() {
        double[] closes = new double[21];
        for (int i = 0; i < 21; i++) closes[i] = 100 + Math.sin(i) * 0.5;

        var result = BollingerMeanReversionEngine.evaluate(closes);
        assertThat(result.fadeSignal()).isEqualTo("NEUTRAL");
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100, 101, 102 };
        assertThat(BollingerMeanReversionEngine.evaluate(closes, 20)).isNull();
    }
}
