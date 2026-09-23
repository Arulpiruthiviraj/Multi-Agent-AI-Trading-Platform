package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class Ta4jTechnicalParityEngineTest {

    /** Deterministic synthetic walk, long enough to clear MACD's 26-period requirement plus warmup. */
    private static double[] syntheticCloses(int n) {
        double[] closes = new double[n];
        double price = 100;
        for (int i = 0; i < n; i++) {
            price += Math.sin(i * 0.3) * 1.5 + Math.cos(i * 0.07) * 0.5;
            closes[i] = price;
        }
        return closes;
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = {100, 101, 102};
        assertThat(Ta4jTechnicalParityEngine.evaluate(closes)).isNull();
    }

    @Test
    void rsiAgreesCloselyBetweenArgusAndTa4jSinceBothImplementTheSameWilderFormula() {
        double[] closes = syntheticCloses(120);
        var result = Ta4jTechnicalParityEngine.evaluate(closes);

        assertThat(result).isNotNull();
        // Both sides implement the same 1978 Wilder RSI formula with the same warmup convention -
        // unlike EMA/MACD/Bollinger (which have a real, documented seeding-convention difference),
        // a large RSI disagreement here would be a genuine defect signal, not an expected gap.
        assertThat(result.rsi().absoluteDifference()).isLessThan(0.5);
    }

    @Test
    void allComparisonsAreFiniteAndPresentForALongEnoughSeries() {
        double[] closes = syntheticCloses(120);
        var result = Ta4jTechnicalParityEngine.evaluate(closes);

        assertThat(result).isNotNull();
        for (var comparison : new Ta4jTechnicalParityEngine.IndicatorComparison[]{
            result.rsi(), result.macd(), result.macdSignal(), result.macdHistogram(),
            result.sma(), result.ema(), result.bollingerUpper(), result.bollingerLower(),
        }) {
            assertThat(comparison.argusValue()).isFinite();
            assertThat(comparison.ta4jValue()).isFinite();
            assertThat(comparison.absoluteDifference()).isFinite().isGreaterThanOrEqualTo(0);
        }
    }
}
