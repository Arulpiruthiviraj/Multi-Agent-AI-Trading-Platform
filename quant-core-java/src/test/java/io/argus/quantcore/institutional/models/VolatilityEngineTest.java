package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;

class VolatilityEngineTest {

    @Test
    void attachesARealGarchFitWhenEnoughReturnsExist() {
        Random rnd = new Random(3);
        double[] closes = new double[100];
        double price = 100;
        for (int i = 0; i < 100; i++) {
            price *= 1 + rnd.nextGaussian() * 0.01;
            closes[i] = price;
        }
        VolatilityEngine.VolatilityAssessment result = VolatilityEngine.assess("AAPL", closes, 20);
        assertThat(result.garchForecastVolatility()).isNotNull();
        assertThat(result.garchAlpha()).isBetween(0.0, 1.0);
        assertThat(result.realizedVolatility()).isGreaterThanOrEqualTo(0.0);
        assertThat(result.realizedVolPercentile()).isBetween(0.0, 1.0);
    }

    @Test
    void leavesGarchFieldsNullRatherThanFabricatingBelowItsOwnFitFloor() {
        double[] closes = {100, 101, 99, 102, 103}; // far below GarchEngine.fit()'s 30-return floor
        VolatilityEngine.VolatilityAssessment result = VolatilityEngine.assess("THIN", closes, 3);
        assertThat(result.garchForecastVolatility()).isNull();
        assertThat(result.garchAlpha()).isNull();
        assertThat(result.garchBeta()).isNull();
    }

    @Test
    void flagsCompressionWhenCurrentVolatilityIsAtTheLowEndOfItsOwnHistory() {
        Random rnd = new Random(9);
        double[] closes = new double[120];
        double price = 100;
        for (int i = 0; i < 120; i++) {
            // High vol for most of the history, then a long, genuinely calm stretch at the end.
            double vol = i < 100 ? 0.03 : 0.001;
            price *= 1 + rnd.nextGaussian() * vol;
            closes[i] = price;
        }
        VolatilityEngine.VolatilityAssessment result = VolatilityEngine.assess("CALM", closes, 15);
        assertThat(result.compressed()).isTrue();
        assertThat(result.expanded()).isFalse();
    }
}
