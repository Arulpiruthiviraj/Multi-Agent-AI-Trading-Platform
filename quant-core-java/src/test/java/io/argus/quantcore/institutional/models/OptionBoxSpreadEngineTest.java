package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionBoxSpreadEngineTest {

    @Test
    void longBox_fairValueIsTheStrikeWidth_regardlessOfCost() {
        var result = OptionBoxSpreadEngine.evaluateLongBox(100, 105, 4.50);
        assertThat(result).isNotNull();
        assertThat(result.fairValue()).isCloseTo(5.0, within(1e-9));
        assertThat(result.edge()).isCloseTo(0.50, within(1e-9)); // bought below fair value -> positive edge
    }

    @Test
    void longBox_negativeEdge_whenOverpaying() {
        var result = OptionBoxSpreadEngine.evaluateLongBox(100, 105, 5.20);
        assertThat(result).isNotNull();
        assertThat(result.edge()).isCloseTo(-0.20, within(1e-9));
    }

    @Test
    void shortBox_positiveEdge_whenCreditExceedsFairValue() {
        var result = OptionBoxSpreadEngine.evaluateShortBox(100, 105, 5.30);
        assertThat(result).isNotNull();
        assertThat(result.fairValue()).isCloseTo(5.0, within(1e-9));
        assertThat(result.edge()).isCloseTo(0.30, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenStrikesMisordered() {
        assertThat(OptionBoxSpreadEngine.evaluateLongBox(105, 100, 4.50)).isNull();
    }
}
