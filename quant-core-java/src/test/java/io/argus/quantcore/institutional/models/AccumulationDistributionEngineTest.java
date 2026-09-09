package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class AccumulationDistributionEngineTest {

    @Test
    void closeAtTheHighOfItsRangeContributesFullyPositiveMoneyFlow() {
        double[] highs = { 100, 110 };
        double[] lows = { 90, 100 };
        double[] closes = { 95, 110 }; // second bar closes exactly at its high -> multiplier = +1
        double[] volumes = { 1000, 2000 };

        double[] ad = AccumulationDistributionEngine.calculate(highs, lows, closes, volumes);

        assertThat(ad[1]).isEqualTo(ad[0] + 2000.0); // full volume added, multiplier=1
    }

    @Test
    void closeAtTheLowOfItsRangeContributesFullyNegativeMoneyFlow() {
        double[] highs = { 100, 110 };
        double[] lows = { 90, 100 };
        double[] closes = { 95, 100 }; // second bar closes exactly at its low -> multiplier = -1
        double[] volumes = { 1000, 2000 };

        double[] ad = AccumulationDistributionEngine.calculate(highs, lows, closes, volumes);

        assertThat(ad[1]).isEqualTo(ad[0] - 2000.0);
    }

    @Test
    void aZeroRangeBarContributesNothingRatherThanDividingByZero() {
        double[] highs = { 100, 100 };
        double[] lows = { 90, 100 }; // second bar: high == low
        double[] closes = { 95, 100 };
        double[] volumes = { 1000, 2000 };

        double[] ad = AccumulationDistributionEngine.calculate(highs, lows, closes, volumes);

        assertThat(ad[1]).isEqualTo(ad[0]); // unchanged - zero contribution, not NaN/Infinity
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] highs = { 100, 101 };
        double[] lows = { 90, 91 };
        double[] closes = { 95, 96 };
        double[] volumes = { 1000, 1100 };
        assertThat(AccumulationDistributionEngine.evaluate(highs, lows, closes, volumes, 10)).isNull();
    }
}
