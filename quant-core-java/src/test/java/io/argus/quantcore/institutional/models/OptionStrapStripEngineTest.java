package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionStrapStripEngineTest {

    @Test
    void strap_matchesThePapersOwnClosedForm() {
        var result = OptionStrapStripEngine.evaluate(OptionStrapStripEngine.Position.STRAP, 100, 10);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(105, within(1e-9)); // K + D/2
        assertThat(result.breakevenLower()).isCloseTo(90, within(1e-9)); // K - D
        assertThat(result.maxLoss()).isCloseTo(10, within(1e-9));
    }

    @Test
    void strip_matchesThePapersOwnClosedForm() {
        var result = OptionStrapStripEngine.evaluate(OptionStrapStripEngine.Position.STRIP, 100, 10);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(110, within(1e-9)); // K + D
        assertThat(result.breakevenLower()).isCloseTo(95, within(1e-9)); // K - D/2
        assertThat(result.maxLoss()).isCloseTo(10, within(1e-9));
    }

    @Test
    void strapsUpperBreakevenIsCloserToStrike_thanStripsUpperBreakeven() {
        // Strap weights calls 2:1 -> needs a smaller upside move to break even than strip.
        var strap = OptionStrapStripEngine.evaluate(OptionStrapStripEngine.Position.STRAP, 100, 10);
        var strip = OptionStrapStripEngine.evaluate(OptionStrapStripEngine.Position.STRIP, 100, 10);
        assertThat(strap).isNotNull();
        assertThat(strip).isNotNull();
        assertThat(strap.breakevenUpper()).isLessThan(strip.breakevenUpper());
    }

    @Test
    void returnsNullRatherThanFabricating_whenDebitIsNotPositive() {
        assertThat(OptionStrapStripEngine.evaluate(OptionStrapStripEngine.Position.STRAP, 100, 0)).isNull();
    }
}
