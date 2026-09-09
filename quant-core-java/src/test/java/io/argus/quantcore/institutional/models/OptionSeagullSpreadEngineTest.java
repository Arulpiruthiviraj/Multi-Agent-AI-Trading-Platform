package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionSeagullSpreadEngineTest {

    @Test
    void bullishShortSeagull_positivePremium_usesUpperBreakeven() {
        var result = OptionSeagullSpreadEngine.evaluate(OptionSeagullSpreadEngine.SeagullType.BULLISH_SHORT_SEAGULL, 90, 100, 110, 2);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(102, within(1e-9)); // K2+H
        assertThat(result.maxProfit()).isCloseTo(110 - 100 - 2, within(1e-9));
        assertThat(result.maxLoss()).isCloseTo(92, within(1e-9)); // K1+H
    }

    @Test
    void bullishShortSeagull_negativePremium_usesLowerBreakeven() {
        var result = OptionSeagullSpreadEngine.evaluate(OptionSeagullSpreadEngine.SeagullType.BULLISH_SHORT_SEAGULL, 90, 100, 110, -2);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(88, within(1e-9)); // K1+H
    }

    @Test
    void bullishShortSeagull_zeroPremium_givesARangeInsteadOfAPoint() {
        var result = OptionSeagullSpreadEngine.evaluate(OptionSeagullSpreadEngine.SeagullType.BULLISH_SHORT_SEAGULL, 90, 100, 110, 0);
        assertThat(result).isNotNull();
        assertThat(result.breakevenRangeLower()).isCloseTo(90, within(1e-9));
        assertThat(result.breakevenRangeUpper()).isCloseTo(100, within(1e-9));
    }

    @Test
    void bearishShortSeagull_hasUnlimitedMaxLoss() {
        var result = OptionSeagullSpreadEngine.evaluate(OptionSeagullSpreadEngine.SeagullType.BEARISH_SHORT_SEAGULL, 90, 100, 110, 2);
        assertThat(result).isNotNull();
        assertThat(result.maxLoss()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void bullishLongSeagull_hasUnlimitedMaxProfit() {
        var result = OptionSeagullSpreadEngine.evaluate(OptionSeagullSpreadEngine.SeagullType.BULLISH_LONG_SEAGULL, 90, 100, 110, 2);
        assertThat(result).isNotNull();
        assertThat(result.maxProfit()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxLoss()).isCloseTo(100 - 90 + 2, within(1e-9)); // K2-K1+H
    }

    @Test
    void bearishLongSeagull_matchesThePapersOwnClosedForm() {
        var result = OptionSeagullSpreadEngine.evaluate(OptionSeagullSpreadEngine.SeagullType.BEARISH_LONG_SEAGULL, 90, 100, 110, 2);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(88, within(1e-9)); // K1-H
        assertThat(result.maxProfit()).isCloseTo(88, within(1e-9)); // K1-H
        assertThat(result.maxLoss()).isCloseTo(110 - 100 + 2, within(1e-9)); // K3-K2+H
    }

    @Test
    void returnsNullRatherThanFabricating_whenStrikesMisordered() {
        assertThat(OptionSeagullSpreadEngine.evaluate(OptionSeagullSpreadEngine.SeagullType.BULLISH_SHORT_SEAGULL, 100, 90, 110, 2)).isNull();
    }
}
