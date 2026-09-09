package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionSingleLegEngineTest {

    @Test
    void longCall_matchesKawadkarsWorkedExample() {
        // Nelson pays 5 premium for a 58-strike call; breakeven = 63.
        var result = OptionSingleLegEngine.evaluate(OptionSingleLegEngine.Position.LONG_CALL, 58, 5, Double.NaN);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(63, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(5, within(1e-9));
        assertThat(result.maxReward()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void shortCall_matchesKawadkarsWorkedExample() {
        // Nelson shorts a 2640-strike call for 160 premium; breakeven = 2800.
        var result = OptionSingleLegEngine.evaluate(OptionSingleLegEngine.Position.SHORT_CALL, 2640, 160, Double.NaN);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(2800, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(160, within(1e-9));
        assertThat(result.maxRisk()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void longPut_matchesKawadkarsWorkedExample_andUsesAsxsBoundedMaxReward() {
        // Nelson buys a 2640-strike put for 30 premium; breakeven = 2610.
        var result = OptionSingleLegEngine.evaluate(OptionSingleLegEngine.Position.LONG_PUT, 2640, 30, Double.NaN);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(2610, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(30, within(1e-9));
        // ASX's precise bounded formula: strike - premium (not Double.POSITIVE_INFINITY).
        assertThat(result.maxReward()).isCloseTo(2640 - 30, within(1e-9));
    }

    @Test
    void shortPut_matchesKawadkarsWorkedExample_andUsesAsxsBoundedMaxRisk() {
        // Nelson shorts a 3800-strike put for 171 premium; breakeven = 3629.
        var result = OptionSingleLegEngine.evaluate(OptionSingleLegEngine.Position.SHORT_PUT, 3800, 171, Double.NaN);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(3629, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(171, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(3800 - 171, within(1e-9));
    }

    @Test
    void payoffAtExpiry_isComputedNetOfPremium_forLongCall() {
        var result = OptionSingleLegEngine.evaluate(OptionSingleLegEngine.Position.LONG_CALL, 100, 4, 110);
        assertThat(result).isNotNull();
        assertThat(result.payoffAtExpiry()).isCloseTo(10 - 4, within(1e-9));
    }

    @Test
    void payoffAtExpiry_isNaN_whenSpotAtExpiryNotSupplied() {
        var result = OptionSingleLegEngine.evaluate(OptionSingleLegEngine.Position.LONG_CALL, 100, 4, Double.NaN);
        assertThat(result).isNotNull();
        assertThat(result.payoffAtExpiry()).isNaN();
    }

    @Test
    void returnsNullRatherThanFabricating_whenStrikeOrPremiumInvalid() {
        assertThat(OptionSingleLegEngine.evaluate(OptionSingleLegEngine.Position.LONG_CALL, 0, 5, Double.NaN)).isNull();
        assertThat(OptionSingleLegEngine.evaluate(OptionSingleLegEngine.Position.LONG_CALL, 100, -1, Double.NaN)).isNull();
    }
}
