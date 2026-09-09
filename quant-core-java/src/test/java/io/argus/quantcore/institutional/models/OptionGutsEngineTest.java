package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionGutsEngineTest {

    @Test
    void longGuts_matchesThePapersOwnClosedForm() {
        // K1=95 (ITM call), K2=105 (ITM put), width=10, premium=15 (> width, required).
        var result = OptionGutsEngine.evaluate(OptionGutsEngine.Position.LONG_GUTS, 95, 105, 15);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(110, within(1e-9)); // K1+premium
        assertThat(result.breakevenLower()).isCloseTo(90, within(1e-9)); // K2-premium
        assertThat(result.maxProfit()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxLoss()).isCloseTo(5, within(1e-9)); // premium - width
    }

    @Test
    void shortGuts_isTheMirrorOfLongGuts() {
        var result = OptionGutsEngine.evaluate(OptionGutsEngine.Position.SHORT_GUTS, 95, 105, 15);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(110, within(1e-9));
        assertThat(result.breakevenLower()).isCloseTo(90, within(1e-9));
        assertThat(result.maxProfit()).isCloseTo(5, within(1e-9));
        assertThat(result.maxLoss()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void returnsNullRatherThanFabricating_whenPremiumDoesNotExceedStrikeWidth() {
        // The paper's own precondition: D > K2-K1, otherwise the trade would be risk-free arbitrage.
        assertThat(OptionGutsEngine.evaluate(OptionGutsEngine.Position.LONG_GUTS, 95, 105, 8)).isNull();
    }

    @Test
    void returnsNull_whenStrikesMisordered() {
        assertThat(OptionGutsEngine.evaluate(OptionGutsEngine.Position.LONG_GUTS, 105, 95, 15)).isNull();
    }
}
