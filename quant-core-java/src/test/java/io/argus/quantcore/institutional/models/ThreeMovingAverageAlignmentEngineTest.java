package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ThreeMovingAverageAlignmentEngineTest {

    @Test
    void readsBullish_whenPriceHasBeenRisingSteadilyLongEnoughForFullAlignment() {
        double[] closes = new double[40];
        for (int i = 0; i < closes.length; i++) {
            closes[i] = 100 + i * 1.0;
        }

        var result = ThreeMovingAverageAlignmentEngine.evaluate(closes, 3, 10, 21);

        assertThat(result).isNotNull();
        assertThat(result.alignment()).isEqualTo("BULLISH");
        assertThat(result.maFast()).isGreaterThan(result.maMedium());
        assertThat(result.maMedium()).isGreaterThan(result.maSlow());
    }

    @Test
    void readsBearish_whenPriceHasBeenFallingSteadilyLongEnoughForFullAlignment() {
        double[] closes = new double[40];
        for (int i = 0; i < closes.length; i++) {
            closes[i] = 200 - i * 1.0;
        }

        var result = ThreeMovingAverageAlignmentEngine.evaluate(closes, 3, 10, 21);

        assertThat(result).isNotNull();
        assertThat(result.alignment()).isEqualTo("BEARISH");
    }

    @Test
    void readsMixed_whenPriceIsFlatAndTheThreeAveragesAreNotCleanlyOrdered() {
        double[] closes = new double[40];
        for (int i = 0; i < closes.length; i++) {
            closes[i] = 100 + (i % 2 == 0 ? 0.1 : -0.1);
        }

        var result = ThreeMovingAverageAlignmentEngine.evaluate(closes, 3, 10, 21);

        assertThat(result).isNotNull();
        assertThat(result.alignment()).isEqualTo("MIXED");
    }

    @Test
    void returnsNullRatherThanFabricating_whenThereIsNotEnoughHistoryForTheSlowestAverage() {
        double[] closes = new double[15];
        for (int i = 0; i < closes.length; i++) {
            closes[i] = 100 + i;
        }

        assertThat(ThreeMovingAverageAlignmentEngine.evaluate(closes, 3, 10, 21)).isNull();
    }

    @Test
    void returnsNull_whenPeriodsAreNotStrictlyIncreasing() {
        double[] closes = new double[40];
        for (int i = 0; i < closes.length; i++) closes[i] = 100 + i;

        assertThat(ThreeMovingAverageAlignmentEngine.evaluate(closes, 10, 10, 21)).isNull();
        assertThat(ThreeMovingAverageAlignmentEngine.evaluate(closes, 3, 21, 21)).isNull();
    }

    @Test
    void defaultOverload_usesThePapersOwnWorkedExampleOf3_10_21() {
        double[] closes = new double[40];
        for (int i = 0; i < closes.length; i++) {
            closes[i] = 100 + i * 1.0;
        }

        var withDefaults = ThreeMovingAverageAlignmentEngine.evaluate(closes);
        var withExplicitArgs = ThreeMovingAverageAlignmentEngine.evaluate(closes, 3, 10, 21);

        assertThat(withDefaults).isEqualTo(withExplicitArgs);
    }
}
