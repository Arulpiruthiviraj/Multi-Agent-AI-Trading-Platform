package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionComboEngineTest {

    @Test
    void longCombo_positivePremium_usesHigherStrikeBreakeven() {
        var result = OptionComboEngine.evaluate(OptionComboEngine.Position.LONG_COMBO, 110, 90, 2);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(112, within(1e-9)); // K1+H
        assertThat(result.maxProfit()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxLoss()).isCloseTo(92, within(1e-9)); // K2+H
    }

    @Test
    void longCombo_negativePremium_usesLowerStrikeBreakeven() {
        var result = OptionComboEngine.evaluate(OptionComboEngine.Position.LONG_COMBO, 110, 90, -2);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(88, within(1e-9)); // K2+H
    }

    @Test
    void longCombo_zeroPremium_givesARange() {
        var result = OptionComboEngine.evaluate(OptionComboEngine.Position.LONG_COMBO, 110, 90, 0);
        assertThat(result).isNotNull();
        assertThat(result.breakevenRangeLower()).isCloseTo(90, within(1e-9));
        assertThat(result.breakevenRangeUpper()).isCloseTo(110, within(1e-9));
    }

    @Test
    void shortCombo_matchesThePapersOwnClosedForm() {
        var result = OptionComboEngine.evaluate(OptionComboEngine.Position.SHORT_COMBO, 110, 90, 2);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(88, within(1e-9)); // K1-H
        assertThat(result.maxProfit()).isCloseTo(88, within(1e-9)); // K1-H
        assertThat(result.maxLoss()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void returnsNullRatherThanFabricating_whenStrikesMisordered() {
        assertThat(OptionComboEngine.evaluate(OptionComboEngine.Position.LONG_COMBO, 90, 110, 2)).isNull();
    }
}
