package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionButterflyEngineTest {

    @Test
    void longCallButterfly_matchesKawadkarsWorkedExample() {
        // 6100/6200/6300, net premium paid 7 -> BEP upper 6293, BEP lower 6107, maxRisk 7, maxReward 93.
        var result = OptionButterflyEngine.evaluate(OptionButterflyEngine.Position.LONG_BUTTERFLY, 6100, 6200, 6300, 7);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(6107, within(1e-9));
        assertThat(result.breakevenUpper()).isCloseTo(6293, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(7, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(93, within(1e-9));
    }

    @Test
    void shortCallButterfly_matchesKawadkarsOwnPayoffTable_notItsAmbiguousBreakevenText() {
        // Kawadkar's own numeric payoff table for the short variant shows net payoff = 0 at BOTH
        // 6107 and 6293 (the same points as the long variant), confirming the independently
        // re-derived A+premium/C-premium formula - not "B plus or minus cost" as loosely stated
        // in a different source for this same strategy shape.
        var result = OptionButterflyEngine.evaluate(OptionButterflyEngine.Position.SHORT_BUTTERFLY, 6100, 6200, 6300, 7);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(6107, within(1e-9));
        assertThat(result.breakevenUpper()).isCloseTo(6293, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(7, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(93, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenWingsAreNotEquidistant() {
        assertThat(OptionButterflyEngine.evaluate(OptionButterflyEngine.Position.LONG_BUTTERFLY, 100, 105, 115, 2)).isNull();
    }

    @Test
    void returnsNull_whenNetPremiumExceedsWingWidth() {
        assertThat(OptionButterflyEngine.evaluate(OptionButterflyEngine.Position.LONG_BUTTERFLY, 100, 105, 110, 6)).isNull();
    }
}
