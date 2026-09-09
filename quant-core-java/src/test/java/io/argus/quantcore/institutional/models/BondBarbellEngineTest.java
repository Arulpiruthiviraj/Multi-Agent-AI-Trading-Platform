package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class BondBarbellEngineTest {

    @Test
    void barbellHasHigherConvexityThanTheMatchingDurationBullet() {
        var result = BondBarbellEngine.evaluate(50, 2, 50, 10, 0.03);
        assertThat(result).isNotNull();
        assertThat(result.barbellConvexity()).isGreaterThan(result.bulletConvexity());
        assertThat(result.convexityAdvantage()).isGreaterThan(0);
    }

    @Test
    void convexityAdvantage_matchesTheDirectlyComputedDifference() {
        var result = BondBarbellEngine.evaluate(50, 2, 50, 10, 0.03);
        assertThat(result).isNotNull();
        double directDifference = result.barbellConvexity() - result.bulletConvexity();
        assertThat(result.convexityAdvantage()).isCloseTo(directDifference, within(1e-6));
    }

    @Test
    void bulletMaturityEqualsTheBarbellsOwnDuration() {
        var result = BondBarbellEngine.evaluate(50, 2, 50, 10, 0.03);
        assertThat(result).isNotNull();
        assertThat(result.bulletMaturity()).isCloseTo(result.barbellDuration(), within(1e-9));
    }

    @Test
    void equalDollarWeighting_givesDurationHalfwayBetweenMaturities_whenYieldIsZero() {
        // With Y=0, wBar_i = w_i exactly, so equal dollar weights give a simple average maturity.
        var result = BondBarbellEngine.evaluate(50, 2, 50, 10, 0.0);
        assertThat(result).isNotNull();
        assertThat(result.barbellDuration()).isCloseTo(6.0, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenMaturitiesMisordered() {
        assertThat(BondBarbellEngine.evaluate(50, 10, 50, 2, 0.03)).isNull();
    }
}
