package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionVerticalSpreadEngineTest {

    @Test
    void bullCallSpread_matchesFidelitysWorkedExample() {
        // Buy 100 call (3.30), sell 105 call (1.50), net debit 1.80 -> breakeven 101.80, maxRisk 1.80, maxReward 3.20.
        var result = OptionVerticalSpreadEngine.evaluate(OptionVerticalSpreadEngine.SpreadType.BULL_CALL, 100, 105, -1.80);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(101.80, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(1.80, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(3.20, within(1e-9));
    }

    @Test
    void bullPutSpread_matchesFidelitysWorkedExample() {
        // Sell 100 put (3.20), buy 95 put (1.30), net credit 1.90 -> breakeven 98.10, maxReward 1.90, maxRisk 3.10.
        var result = OptionVerticalSpreadEngine.evaluate(OptionVerticalSpreadEngine.SpreadType.BULL_PUT, 95, 100, 1.90);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(98.10, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(1.90, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(3.10, within(1e-9));
    }

    @Test
    void bearCallSpread_matchesFidelitysWorkedExample() {
        // Sell 100 call (3.30), buy 105 call (1.50), net credit 1.80 -> breakeven 101.80, maxReward 1.80, maxRisk 3.20.
        var result = OptionVerticalSpreadEngine.evaluate(OptionVerticalSpreadEngine.SpreadType.BEAR_CALL, 100, 105, 1.80);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(101.80, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(1.80, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(3.20, within(1e-9));
    }

    @Test
    void bearPutSpread_matchesFidelitysWorkedExample() {
        // Buy 100 put (3.20), sell 95 put (1.30), net debit 1.90 -> breakeven 98.10, maxReward 3.10, maxRisk 1.90.
        var result = OptionVerticalSpreadEngine.evaluate(OptionVerticalSpreadEngine.SpreadType.BEAR_PUT, 95, 100, -1.90);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(98.10, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(3.10, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(1.90, within(1e-9));
    }

    @Test
    void maxRiskPlusMaxReward_alwaysEqualsTheStrikeWidth_acrossAllFourVariants() {
        double width = 5.0;
        for (OptionVerticalSpreadEngine.SpreadType type : OptionVerticalSpreadEngine.SpreadType.values()) {
            var result = OptionVerticalSpreadEngine.evaluate(type, 100, 105, 1.50);
            assertThat(result).isNotNull();
            assertThat(result.maxRisk() + result.maxReward()).isCloseTo(width, within(1e-9));
        }
    }

    @Test
    void returnsNullRatherThanFabricating_whenStrikesMisordered() {
        assertThat(OptionVerticalSpreadEngine.evaluate(OptionVerticalSpreadEngine.SpreadType.BULL_CALL, 105, 100, -1.80)).isNull();
    }

    @Test
    void returnsNull_whenNetPremiumExceedsWidth() {
        assertThat(OptionVerticalSpreadEngine.evaluate(OptionVerticalSpreadEngine.SpreadType.BULL_CALL, 100, 105, -6.0)).isNull();
    }
}
