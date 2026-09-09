package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class RsiMeanReversionEngineTest {

    @Test
    void signalsBuyWhenTwoPeriodRsiIsDeeplyOversold() {
        // Sharp multi-bar decline drives 2-period RSI well below the conventional 10 threshold.
        double[] closes = new double[10];
        double price = 100;
        for (int i = 0; i < closes.length; i++) {
            closes[i] = price;
            price *= 0.97;
        }

        var result = RsiMeanReversionEngine.evaluate(closes);
        assertThat(result).isNotNull();
        assertThat(result.rsi()).isLessThan(RsiMeanReversionEngine.DEFAULT_OVERSOLD);
        assertThat(result.oversold()).isTrue();
        assertThat(result.fadeSignal()).isEqualTo("BUY");
    }

    @Test
    void signalsSellWhenTwoPeriodRsiIsDeeplyOverbought() {
        double[] closes = new double[10];
        double price = 100;
        for (int i = 0; i < closes.length; i++) {
            closes[i] = price;
            price *= 1.03;
        }

        var result = RsiMeanReversionEngine.evaluate(closes);
        assertThat(result.overbought()).isTrue();
        assertThat(result.fadeSignal()).isEqualTo("SELL");
    }

    @Test
    void reportsNeutralOnAlternatingUpDownPriceAction() {
        // A perfectly flat series has zero losses, which RSI's own formula reports as 100
        // (see RSI.java's avgLoss==0 branch) - not a neutral case. Alternating moves of equal
        // magnitude average out to RSI 50, the genuinely neutral case.
        double[] closes = new double[10];
        for (int i = 0; i < closes.length; i++) closes[i] = 100 + (i % 2 == 0 ? 0 : 1);

        var result = RsiMeanReversionEngine.evaluate(closes);
        assertThat(result).isNotNull();
        assertThat(result.fadeSignal()).isEqualTo("NEUTRAL");
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100 };
        assertThat(RsiMeanReversionEngine.evaluate(closes, 2, 10, 70)).isNull();
    }

    @Test
    void rejectsAnOverboughtThresholdThatIsNotStrictlyAboveOversold() {
        double[] closes = new double[10];
        for (int i = 0; i < closes.length; i++) closes[i] = 100 + i;
        assertThat(RsiMeanReversionEngine.evaluate(closes, 2, 50, 50)).isNull();
    }
}
