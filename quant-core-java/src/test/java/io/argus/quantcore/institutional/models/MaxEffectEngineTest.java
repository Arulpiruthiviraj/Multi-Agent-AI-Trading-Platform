package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MaxEffectEngineTest {

    @Test
    void findsTheSingleLargestDailyReturnInTheWindow() {
        double[] closes = new double[22];
        for (int i = 0; i < 22; i++) closes[i] = 100;
        closes[15] = closes[14] * 1.25; // one sharp +25% day well inside the 21-day window

        var result = MaxEffectEngine.evaluate(closes, 21, 5, 0.10);

        assertThat(result).isNotNull();
        assertThat(result.maxDailyReturn()).isCloseTo(0.25, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.extremeLotteryDemand()).isTrue();
    }

    @Test
    void topKAverageIsLowerThanTheSingleMaxWhenOnlyOneDayIsExtreme() {
        double[] closes = new double[22];
        for (int i = 0; i < 22; i++) closes[i] = 100;
        closes[15] = closes[14] * 1.25;

        var result = MaxEffectEngine.evaluate(closes, 21, 5, 0.10);

        assertThat(result.topKAverageReturn()).isLessThan(result.maxDailyReturn());
    }

    @Test
    void doesNotFlagExtremeLotteryDemandForOrdinaryDailyMoves() {
        double[] closes = new double[22];
        for (int i = 0; i < 22; i++) closes[i] = 100 + (i % 2 == 0 ? 0.5 : -0.5); // small day-to-day noise

        var result = MaxEffectEngine.evaluate(closes, 0.10);

        assertThat(result.extremeLotteryDemand()).isFalse();
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100, 101, 102 };
        assertThat(MaxEffectEngine.evaluate(closes, 21, 5, 0.10)).isNull();
    }
}
