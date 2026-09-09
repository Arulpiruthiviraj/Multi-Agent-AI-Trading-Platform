package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class InternalBarStrengthEngineTest {

    @Test
    void computesIbsAsZero_whenCloseIsAtTheLow() {
        var result = InternalBarStrengthEngine.evaluate(110, 100, 100);

        assertThat(result).isNotNull();
        assertThat(result.ibs()).isCloseTo(0.0, within(1e-9));
        assertThat(result.signal()).isEqualTo("BUY");
    }

    @Test
    void computesIbsAsOne_whenCloseIsAtTheHigh() {
        var result = InternalBarStrengthEngine.evaluate(110, 100, 110);

        assertThat(result).isNotNull();
        assertThat(result.ibs()).isCloseTo(1.0, within(1e-9));
        assertThat(result.signal()).isEqualTo("SELL");
    }

    @Test
    void computesIbsAsHalf_whenCloseIsAtTheMidpoint_andSignalsNeutral() {
        var result = InternalBarStrengthEngine.evaluate(110, 100, 105);

        assertThat(result).isNotNull();
        assertThat(result.ibs()).isCloseTo(0.5, within(1e-9));
        assertThat(result.signal()).isEqualTo("NEUTRAL");
    }

    @Test
    void respectsCallerSuppliedThresholds() {
        var result = InternalBarStrengthEngine.evaluate(110, 100, 103, 0.5, 0.5);

        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("BUY");
    }

    @Test
    void returnsNullRatherThanFabricating_whenTheBarsHighLowRangeIsZero() {
        assertThat(InternalBarStrengthEngine.evaluate(100, 100, 100)).isNull();
    }

    @Test
    void returnsNull_whenRangeIsNegativeOrDegenerate() {
        assertThat(InternalBarStrengthEngine.evaluate(90, 100, 95)).isNull();
    }

    @Test
    void defaultOverload_usesThePapersOwnCommonlyCitedThresholdsOf0_2And0_8() {
        var withDefaults = InternalBarStrengthEngine.evaluate(110, 100, 101);
        var withExplicitArgs = InternalBarStrengthEngine.evaluate(110, 100, 101, 0.2, 0.8);

        assertThat(withDefaults).isEqualTo(withExplicitArgs);
    }
}
