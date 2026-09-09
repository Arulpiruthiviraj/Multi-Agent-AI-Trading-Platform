package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class FuturesTrendFollowingEngineTest {

    @Test
    void positiveReturnsGetPositiveWeight_negativeReturnsGetNegativeWeight() {
        List<FuturesTrendFollowingEngine.FuturesReturn> returns = List.of(
            new FuturesTrendFollowingEngine.FuturesReturn("UP", 0.10, 0.02),
            new FuturesTrendFollowingEngine.FuturesReturn("DOWN", -0.05, 0.02)
        );

        var result = FuturesTrendFollowingEngine.evaluate(returns, false);

        assertThat(result).isNotNull();
        assertThat(result.weights().get("UP")).isGreaterThan(0);
        assertThat(result.weights().get("DOWN")).isLessThan(0);
    }

    @Test
    void rawConstructionIsNotNecessarilyDollarNeutral() {
        // Three uptrends, one downtrend - raw (non-demeaned) weights should NOT sum to zero.
        List<FuturesTrendFollowingEngine.FuturesReturn> returns = List.of(
            new FuturesTrendFollowingEngine.FuturesReturn("A", 0.05, 0.02),
            new FuturesTrendFollowingEngine.FuturesReturn("B", 0.03, 0.02),
            new FuturesTrendFollowingEngine.FuturesReturn("C", 0.02, 0.02),
            new FuturesTrendFollowingEngine.FuturesReturn("D", -0.01, 0.02)
        );

        var result = FuturesTrendFollowingEngine.evaluate(returns, false);

        assertThat(result).isNotNull();
        double sum = result.weights().values().stream().mapToDouble(Double::doubleValue).sum();
        assertThat(sum).isNotCloseTo(0.0, within(1e-6));
    }

    @Test
    void dollarNeutralVariant_alwaysSumsToZero() {
        List<FuturesTrendFollowingEngine.FuturesReturn> returns = List.of(
            new FuturesTrendFollowingEngine.FuturesReturn("A", 0.05, 0.02),
            new FuturesTrendFollowingEngine.FuturesReturn("B", 0.03, 0.02),
            new FuturesTrendFollowingEngine.FuturesReturn("C", 0.02, 0.02),
            new FuturesTrendFollowingEngine.FuturesReturn("D", -0.01, 0.02)
        );

        var result = FuturesTrendFollowingEngine.evaluate(returns, true);

        assertThat(result).isNotNull();
        double sum = result.weights().values().stream().mapToDouble(Double::doubleValue).sum();
        assertThat(sum).isCloseTo(0.0, within(1e-9));

        double sumAbs = result.weights().values().stream().mapToDouble(Math::abs).sum();
        assertThat(sumAbs).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenAnyVolatilityIsNonPositive() {
        List<FuturesTrendFollowingEngine.FuturesReturn> returns = List.of(
            new FuturesTrendFollowingEngine.FuturesReturn("A", 0.05, 0.0),
            new FuturesTrendFollowingEngine.FuturesReturn("B", -0.03, 0.02)
        );
        assertThat(FuturesTrendFollowingEngine.evaluate(returns, false)).isNull();
    }

    @Test
    void returnsNull_whenFewerThanTwoContractsSupplied() {
        List<FuturesTrendFollowingEngine.FuturesReturn> returns = List.of(
            new FuturesTrendFollowingEngine.FuturesReturn("A", 0.05, 0.02)
        );
        assertThat(FuturesTrendFollowingEngine.evaluate(returns, false)).isNull();
    }
}
