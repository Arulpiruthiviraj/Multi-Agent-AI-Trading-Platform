package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MacdCrossoverEngineTest {

    @Test
    void detectsABullishCrossWhenPriceRipsUpThroughASlowDowntrend() {
        // Slow downtrend long enough for MACD to settle below its signal line, then a sharp rally
        // that pulls MACD up through the signal line on the final bar - same shape as
        // MovingAverageCrossoverEngineTest's own bullish-cross fixture.
        int declineBars = 60;
        double[] closes = new double[declineBars + 5];
        double price = 200;
        for (int i = 0; i < declineBars; i++) {
            closes[i] = price;
            price *= 0.99;
        }
        for (int i = declineBars; i < closes.length; i++) {
            price *= 1.05;
            closes[i] = price;
        }

        var result = MacdCrossoverEngine.evaluate(closes);
        assertThat(result).isNotNull();
        assertThat(result.macd()).isGreaterThan(result.signal());
    }

    @Test
    void reportsHistogramConsistentWithMacdMinusSignal() {
        double[] closes = new double[100];
        double price = 100;
        for (int i = 0; i < closes.length; i++) {
            closes[i] = price;
            price *= 1.01;
        }
        var result = MacdCrossoverEngine.evaluate(closes);
        assertThat(result.histogram()).isEqualTo(result.macd() - result.signal(), org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100, 101, 102 };
        assertThat(MacdCrossoverEngine.evaluate(closes, 12, 26, 9)).isNull();
    }

    @Test
    void rejectsALongPeriodThatIsNotStrictlyGreaterThanTheShortPeriod() {
        double[] closes = new double[100];
        for (int i = 0; i < closes.length; i++) closes[i] = 100 + i;
        assertThat(MacdCrossoverEngine.evaluate(closes, 26, 26, 9)).isNull();
    }
}
