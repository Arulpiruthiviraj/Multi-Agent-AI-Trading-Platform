package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionIronCondorEngineTest {

    @Test
    void matchesFidelitysWorkedExample() {
        // 95/100/105/110, net credit 2.80 -> maxRisk 2.20, breakevens 97.20/107.80.
        var result = OptionIronCondorEngine.evaluate(95, 100, 105, 110, 2.80);
        assertThat(result).isNotNull();
        assertThat(result.maxProfit()).isCloseTo(2.80, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(2.20, within(1e-9));
        assertThat(result.breakevenLower()).isCloseTo(97.20, within(1e-9));
        assertThat(result.breakevenUpper()).isCloseTo(107.80, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenWingsUnequal() {
        assertThat(OptionIronCondorEngine.evaluate(95, 100, 105, 120, 2.80)).isNull();
    }

    @Test
    void returnsNull_whenNetCreditExceedsWingWidth() {
        assertThat(OptionIronCondorEngine.evaluate(95, 100, 105, 110, 6.0)).isNull();
    }
}
