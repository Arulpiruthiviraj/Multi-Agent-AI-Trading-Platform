package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionStockCombinationEngineTest {

    @Test
    void coveredCall_matchesFidelitysWorkedExample() {
        // Buy stock at 98, sell 100 call for 3.50 -> breakeven 94.50, maxReward 5.50.
        var result = OptionStockCombinationEngine.coveredCall(98, 100, 3.50);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(94.50, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(94.50, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(5.50, within(1e-9));
    }

    @Test
    void protectivePut_matchesFidelitysWorkedExample() {
        // Buy stock at 100, buy 100 put for 3.25 -> breakeven 103.25, maxRisk 3.25.
        var result = OptionStockCombinationEngine.protectivePut(100, 100, 3.25);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(103.25, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(3.25, within(1e-9));
        assertThat(result.maxReward()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void collar_matchesFidelitysWorkedExample() {
        // Buy stock at 100, buy 95 put (1.60), sell 105 call (1.80), net credit 0.20 -> breakeven 99.80, maxReward 5.20, maxRisk 4.80.
        var result = OptionStockCombinationEngine.collar(100, 95, 105, 0.20);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(99.80, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(5.20, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(4.80, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenCollarStrikesMisordered() {
        assertThat(OptionStockCombinationEngine.collar(100, 105, 95, 0.20)).isNull();
    }
}
