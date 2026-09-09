package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionCondorEngineTest {

    @Test
    void longCondor_computesPlateauProfitAndBoundedBreakevens() {
        var result = OptionCondorEngine.evaluate(OptionCondorEngine.Position.LONG_CONDOR, 90, 95, 105, 110, 2);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(92, within(1e-9));
        assertThat(result.breakevenUpper()).isCloseTo(108, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(2, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(3, within(1e-9));
    }

    @Test
    void shortCondor_mirrorsLongCondorsRiskAndReward() {
        var result = OptionCondorEngine.evaluate(OptionCondorEngine.Position.SHORT_CONDOR, 90, 95, 105, 110, 2);
        assertThat(result).isNotNull();
        assertThat(result.breakevenLower()).isCloseTo(92, within(1e-9));
        assertThat(result.breakevenUpper()).isCloseTo(108, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(2, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(3, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenWingsUnequal() {
        assertThat(OptionCondorEngine.evaluate(OptionCondorEngine.Position.LONG_CONDOR, 90, 95, 105, 120, 2)).isNull();
    }

    @Test
    void returnsNull_whenStrikesNotStrictlyOrdered() {
        assertThat(OptionCondorEngine.evaluate(OptionCondorEngine.Position.LONG_CONDOR, 95, 90, 105, 110, 2)).isNull();
    }
}
