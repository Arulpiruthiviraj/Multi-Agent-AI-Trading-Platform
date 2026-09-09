package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class VarianceSwapEngineTest {

    @Test
    void realizedVariance_isZero_forAConstantPriceSeries() {
        double[] closes = {100, 100, 100, 100, 100};
        Double v = VarianceSwapEngine.realizedVariance(closes, 252);
        assertThat(v).isNotNull();
        assertThat(v).isCloseTo(0.0, within(1e-12));
    }

    @Test
    void realizedVariance_matchesHandComputedValue_forAConstantDailyReturn() {
        // Constant 1% daily log-return: r = ln(1.01) each day, for 4 days.
        double[] closes = new double[5];
        closes[0] = 100;
        for (int i = 1; i < 5; i++) closes[i] = closes[i - 1] * 1.01;

        Double v = VarianceSwapEngine.realizedVariance(closes, 252);
        assertThat(v).isNotNull();

        double r = Math.log(1.01);
        double expected = 252.0 / 4 * (4 * r * r);
        assertThat(v).isCloseTo(expected, within(1e-9));
    }

    @Test
    void payoff_isPositive_whenRealizedVarianceExceedsTheStrike() {
        double payoff = VarianceSwapEngine.payoff(10000, 0.09, 0.04); // realized vol 30% vs strike vol 20%
        assertThat(payoff).isCloseTo(10000 * 0.05, within(1e-9));
        assertThat(payoff).isGreaterThan(0);
    }

    @Test
    void payoff_isNegative_whenRealizedVarianceIsBelowTheStrike() {
        double payoff = VarianceSwapEngine.payoff(10000, 0.01, 0.04);
        assertThat(payoff).isLessThan(0);
    }

    @Test
    void realizedVariance_returnsNullRatherThanFabricating_whenFewerThanTwoClosesSupplied() {
        assertThat(VarianceSwapEngine.realizedVariance(new double[]{100}, 252)).isNull();
    }

    @Test
    void realizedVariance_returnsNull_whenAnyCloseIsNotPositive() {
        assertThat(VarianceSwapEngine.realizedVariance(new double[]{100, 0, 100}, 252)).isNull();
    }
}
