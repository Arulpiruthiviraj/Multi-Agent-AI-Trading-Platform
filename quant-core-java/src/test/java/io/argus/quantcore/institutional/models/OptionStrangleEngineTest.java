package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionStrangleEngineTest {

    @Test
    void longStrangle_matchesKawadkarsWorkedExample() {
        // Put 5800 (23), call 6200 (43), total 66 -> upper BEP 6266, lower BEP 5734.
        var result = OptionStrangleEngine.evaluate(OptionStrangleEngine.Position.LONG_STRANGLE, 5800, 6200, 66);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(6266, within(1e-9));
        assertThat(result.breakevenLower()).isCloseTo(5734, within(1e-9));
        assertThat(result.maxRiskUpper()).isCloseTo(66, within(1e-9));
        assertThat(result.maxRiskLower()).isCloseTo(66, within(1e-9));
        assertThat(result.maxRewardUpper()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxRewardLower()).isCloseTo(5800 - 66, within(1e-9));
    }

    @Test
    void shortStrangle_matchesKawadkarsWorkedExample() {
        // Put 5800 (23), call 6200 (41), total 64 -> upper BEP 6264, lower BEP 5736.
        var result = OptionStrangleEngine.evaluate(OptionStrangleEngine.Position.SHORT_STRANGLE, 5800, 6200, 64);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(6264, within(1e-9));
        assertThat(result.breakevenLower()).isCloseTo(5736, within(1e-9));
        assertThat(result.maxRewardUpper()).isCloseTo(64, within(1e-9));
        assertThat(result.maxRewardLower()).isCloseTo(64, within(1e-9));
        assertThat(result.maxRiskUpper()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxRiskLower()).isCloseTo(5800 - 64, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenStrikesMisordered() {
        assertThat(OptionStrangleEngine.evaluate(OptionStrangleEngine.Position.LONG_STRANGLE, 6200, 5800, 66)).isNull();
    }
}
