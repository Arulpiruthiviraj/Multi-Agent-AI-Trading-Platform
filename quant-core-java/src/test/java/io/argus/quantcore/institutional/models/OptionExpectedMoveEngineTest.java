package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionExpectedMoveEngineTest {

    @Test
    void matchesTheWorkedExampleFromTheSource() {
        // S=100, IV=30%, T=30/365 -> expected move ~8.60, range ~91.40 to ~108.60.
        var result = OptionExpectedMoveEngine.evaluate(100, 0.30, 30.0 / 365);
        assertThat(result).isNotNull();
        assertThat(result.expectedMove()).isCloseTo(8.60, within(0.02));
        assertThat(result.upperBound()).isCloseTo(108.60, within(0.02));
        assertThat(result.lowerBound()).isCloseTo(91.40, within(0.02));
    }

    @Test
    void higherVolatility_producesALargerExpectedMove() {
        var lowVol = OptionExpectedMoveEngine.evaluate(100, 0.15, 30.0 / 365);
        var highVol = OptionExpectedMoveEngine.evaluate(100, 0.45, 30.0 / 365);
        assertThat(lowVol).isNotNull();
        assertThat(highVol).isNotNull();
        assertThat(highVol.expectedMove()).isGreaterThan(lowVol.expectedMove());
    }

    @Test
    void returnsNullRatherThanFabricating_whenSpotOrTimeIsNotPositive() {
        assertThat(OptionExpectedMoveEngine.evaluate(0, 0.30, 30.0 / 365)).isNull();
        assertThat(OptionExpectedMoveEngine.evaluate(100, 0.30, 0)).isNull();
    }
}
