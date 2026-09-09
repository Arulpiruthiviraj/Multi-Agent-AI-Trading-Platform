package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class FuturesContrarianEngineTest {

    @Test
    void buysLosersAndSellsWinnersRelativeToTheMarketIndex() {
        List<FuturesContrarianEngine.FuturesReturn> returns = List.of(
            new FuturesContrarianEngine.FuturesReturn("WINNER", 0.10, 0.02),
            new FuturesContrarianEngine.FuturesReturn("FLAT", 0.00, 0.02),
            new FuturesContrarianEngine.FuturesReturn("LOSER", -0.10, 0.02)
        );

        var result = FuturesContrarianEngine.evaluate(returns, false);

        assertThat(result).isNotNull();
        assertThat(result.marketIndexReturn()).isCloseTo(0.0, within(1e-9));
        // Contrarian: negative weight on the winner (sell), positive weight on the loser (buy).
        assertThat(result.weights().get("WINNER")).isLessThan(0);
        assertThat(result.weights().get("LOSER")).isGreaterThan(0);
    }

    @Test
    void weightsAreDollarNeutralByConstruction_summingCloseToZero() {
        List<FuturesContrarianEngine.FuturesReturn> returns = List.of(
            new FuturesContrarianEngine.FuturesReturn("A", 0.05, 0.02),
            new FuturesContrarianEngine.FuturesReturn("B", -0.03, 0.02),
            new FuturesContrarianEngine.FuturesReturn("C", 0.01, 0.02),
            new FuturesContrarianEngine.FuturesReturn("D", -0.02, 0.02)
        );

        var result = FuturesContrarianEngine.evaluate(returns, false);

        assertThat(result).isNotNull();
        double sum = result.weights().values().stream().mapToDouble(Double::doubleValue).sum();
        assertThat(sum).isCloseTo(0.0, within(1e-9));

        double sumAbs = result.weights().values().stream().mapToDouble(Math::abs).sum();
        assertThat(sumAbs).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void inverseVolatilityWeighting_suppressesTheHigherVolatilityContractsWeight() {
        List<FuturesContrarianEngine.FuturesReturn> returns = List.of(
            new FuturesContrarianEngine.FuturesReturn("LOW_VOL_LOSER", -0.10, 0.01),
            new FuturesContrarianEngine.FuturesReturn("HIGH_VOL_LOSER", -0.10, 0.10),
            new FuturesContrarianEngine.FuturesReturn("WINNER", 0.20, 0.05)
        );

        var result = FuturesContrarianEngine.evaluate(returns, true);

        assertThat(result).isNotNull();
        // Both losers get positive (buy) weight, but the low-vol one should get MORE weight
        // once suppressed by 1/sigma.
        assertThat(result.weights().get("LOW_VOL_LOSER")).isGreaterThan(result.weights().get("HIGH_VOL_LOSER"));
    }

    @Test
    void inverseVolatilityWeighting_returnsNullRatherThanFabricating_whenAnyVolatilityIsNonPositive() {
        List<FuturesContrarianEngine.FuturesReturn> returns = List.of(
            new FuturesContrarianEngine.FuturesReturn("A", 0.05, 0.0),
            new FuturesContrarianEngine.FuturesReturn("B", -0.03, 0.02)
        );
        assertThat(FuturesContrarianEngine.evaluate(returns, true)).isNull();
    }

    @Test
    void returnsNull_whenFewerThanTwoContractsSupplied() {
        List<FuturesContrarianEngine.FuturesReturn> returns = List.of(
            new FuturesContrarianEngine.FuturesReturn("A", 0.05, 0.02)
        );
        assertThat(FuturesContrarianEngine.evaluate(returns, false)).isNull();
    }
}
