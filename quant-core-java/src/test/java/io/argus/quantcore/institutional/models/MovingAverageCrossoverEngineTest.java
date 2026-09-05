package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MovingAverageCrossoverEngineTest {

    @Test
    void detectsABullishSmaCrossWhenPriceRipsUpThroughASlowDowntrend() {
        // Slow downtrend long enough for both SMAs to have settled below price, then a sharp rally
        // that pulls the fast SMA up through the slow SMA on the final bar.
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

        var result = MovingAverageCrossoverEngine.evaluate(closes, 5, 20, MovingAverageCrossoverEngine.MaType.SMA);
        assertThat(result).isNotNull();
        assertThat(result.fastValue()).isGreaterThan(result.slowValue());
    }

    @Test
    void reportsFastAboveSlowConsistentlyDuringASteadyUptrend() {
        double[] closes = new double[100];
        double price = 100;
        for (int i = 0; i < closes.length; i++) {
            closes[i] = price;
            price *= 1.01;
        }
        var result = MovingAverageCrossoverEngine.evaluate(closes, 10, 30, MovingAverageCrossoverEngine.MaType.EMA);
        assertThat(result.fastAboveSlow()).isTrue();
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100, 101, 102 };
        assertThat(MovingAverageCrossoverEngine.evaluate(closes, 5, 20, MovingAverageCrossoverEngine.MaType.SMA)).isNull();
    }

    @Test
    void rejectsAFastPeriodThatIsNotStrictlyLessThanTheSlowPeriod() {
        double[] closes = new double[100];
        for (int i = 0; i < closes.length; i++) closes[i] = 100 + i;
        assertThat(MovingAverageCrossoverEngine.evaluate(closes, 20, 20, MovingAverageCrossoverEngine.MaType.SMA)).isNull();
    }
}
