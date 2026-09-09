package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionIronButterflyEngineTest {

    @Test
    void longIronButterfly_matchesThePapersOwnClosedForm() {
        var result = OptionIronButterflyEngine.evaluate(OptionIronButterflyEngine.Position.LONG_IRON_BUTTERFLY, 90, 100, 110, 3);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(97, within(1e-9)); // K2-C
        assertThat(result.breakevenUpper()).isCloseTo(103, within(1e-9)); // K2+C
        assertThat(result.maxProfit()).isCloseTo(3, within(1e-9)); // C
        assertThat(result.maxLoss()).isCloseTo(10 - 3, within(1e-9)); // kappa - C
    }

    @Test
    void shortIronButterfly_isTheMirrorOfLongIronButterfly() {
        var result = OptionIronButterflyEngine.evaluate(OptionIronButterflyEngine.Position.SHORT_IRON_BUTTERFLY, 90, 100, 110, 3);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(97, within(1e-9));
        assertThat(result.breakevenUpper()).isCloseTo(103, within(1e-9));
        assertThat(result.maxProfit()).isCloseTo(10 - 3, within(1e-9)); // kappa - D
        assertThat(result.maxLoss()).isCloseTo(3, within(1e-9)); // D
    }

    @Test
    void returnsNullRatherThanFabricating_whenWingsUnequal() {
        assertThat(OptionIronButterflyEngine.evaluate(OptionIronButterflyEngine.Position.LONG_IRON_BUTTERFLY, 90, 100, 115, 3)).isNull();
    }

    @Test
    void returnsNull_whenPremiumExceedsWingWidth() {
        assertThat(OptionIronButterflyEngine.evaluate(OptionIronButterflyEngine.Position.LONG_IRON_BUTTERFLY, 90, 100, 110, 15)).isNull();
    }
}
