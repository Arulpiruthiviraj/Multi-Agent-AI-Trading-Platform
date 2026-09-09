package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionCoveredStraddleEngineTest {

    @Test
    void coveredShortStraddle_matchesThePapersOwnClosedForm() {
        var result = OptionCoveredStraddleEngine.coveredShortStraddle(100, 105, 6);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo((100.0 + 105 - 6) / 2.0, within(1e-9));
        assertThat(result.maxProfit()).isCloseTo(105 - 100 + 6, within(1e-9));
        assertThat(result.maxLoss()).isCloseTo(100 + 105 - 6, within(1e-9));
    }

    @Test
    void coveredShortStrangle_matchesThePapersOwnClosedForm() {
        var result = OptionCoveredStraddleEngine.coveredShortStrangle(100, 105, 95, 4);
        assertThat(result).isNotNull();
        assertThat(result.maxProfit()).isCloseTo(105 - 100 + 4, within(1e-9));
        assertThat(result.maxLoss()).isCloseTo(100 + 95 - 4, within(1e-9));
    }

    @Test
    void coveredShortStrangle_returnsNullRatherThanFabricating_whenPutStrikeNotBelowCallStrike() {
        assertThat(OptionCoveredStraddleEngine.coveredShortStrangle(100, 100, 105, 4)).isNull();
    }
}
