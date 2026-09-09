package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionStraddleEngineTest {

    @Test
    void longStraddle_matchesKawadkarsWorkedExample() {
        // 5400 strike, 69+31=100 total premium -> breakevens 5500/5300, maxRisk=100 both directions.
        var result = OptionStraddleEngine.evaluate(OptionStraddleEngine.Position.LONG_STRADDLE, 5400, 100);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(5500, within(1e-9));
        assertThat(result.breakevenLower()).isCloseTo(5300, within(1e-9));
        assertThat(result.maxRiskUpper()).isCloseTo(100, within(1e-9));
        assertThat(result.maxRiskLower()).isCloseTo(100, within(1e-9));
        assertThat(result.maxRewardUpper()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxRewardLower()).isCloseTo(5400 - 100, within(1e-9));
    }

    @Test
    void shortStraddle_matchesKawadkarsWorkedExample_withAsxsAsymmetricRisk() {
        var result = OptionStraddleEngine.evaluate(OptionStraddleEngine.Position.SHORT_STRADDLE, 5400, 100);
        assertThat(result).isNotNull();
        assertThat(result.breakevenUpper()).isCloseTo(5500, within(1e-9));
        assertThat(result.breakevenLower()).isCloseTo(5300, within(1e-9));
        assertThat(result.maxRewardUpper()).isCloseTo(100, within(1e-9));
        assertThat(result.maxRewardLower()).isCloseTo(100, within(1e-9));
        assertThat(result.maxRiskUpper()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxRiskLower()).isCloseTo(5400 - 100, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenInputsInvalid() {
        assertThat(OptionStraddleEngine.evaluate(OptionStraddleEngine.Position.LONG_STRADDLE, 0, 100)).isNull();
        assertThat(OptionStraddleEngine.evaluate(OptionStraddleEngine.Position.LONG_STRADDLE, 100, -1)).isNull();
    }
}
