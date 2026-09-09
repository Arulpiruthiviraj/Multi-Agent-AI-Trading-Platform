package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionCalendarDiagonalSpreadEngineTest {

    @Test
    void calendarCallSpread_maxProfitEqualsLongLegValueMinusDebit() {
        var result = OptionCalendarDiagonalSpreadEngine.calendarCallSpread(100, 0.25, 0.03, 0.0, 0.25, 1.5);
        assertThat(result).isNotNull();
        assertThat(result.longLegValueAtShortExpiry()).isGreaterThan(0);
        assertThat(result.maxProfit()).isCloseTo(result.longLegValueAtShortExpiry() - 1.5, within(1e-9));
        assertThat(result.maxLoss()).isCloseTo(1.5, within(1e-9));
    }

    @Test
    void calendarPutSpread_maxProfitEqualsLongLegValueMinusDebit() {
        var result = OptionCalendarDiagonalSpreadEngine.calendarPutSpread(100, 0.25, 0.03, 0.0, 0.25, 1.5);
        assertThat(result).isNotNull();
        assertThat(result.longLegValueAtShortExpiry()).isGreaterThan(0);
        assertThat(result.maxProfit()).isCloseTo(result.longLegValueAtShortExpiry() - 1.5, within(1e-9));
    }

    @Test
    void diagonalCallSpread_pricesTheDeepItmLongLegAtTheShortStrike() {
        // Long leg strike 90 (deep ITM if spot near 100), short leg strike 105.
        var result = OptionCalendarDiagonalSpreadEngine.diagonalCallSpread(90, 105, 0.25, 0.03, 0.0, 0.25, 4.0);
        assertThat(result).isNotNull();
        // Priced with spot=105 (short strike), strike=90 -> deep ITM, so value should exceed its own intrinsic (105-90=15).
        assertThat(result.longLegValueAtShortExpiry()).isGreaterThan(15.0);
    }

    @Test
    void diagonalPutSpread_pricesTheDeepItmLongLegAtTheShortStrike() {
        var result = OptionCalendarDiagonalSpreadEngine.diagonalPutSpread(110, 95, 0.25, 0.03, 0.0, 0.25, 4.0);
        assertThat(result).isNotNull();
        assertThat(result.longLegValueAtShortExpiry()).isGreaterThan(15.0); // intrinsic = 110-95
    }

    @Test
    void returnsNullRatherThanFabricating_whenNetDebitIsNotPositive() {
        assertThat(OptionCalendarDiagonalSpreadEngine.calendarCallSpread(100, 0.25, 0.03, 0.0, 0.25, 0)).isNull();
    }

    @Test
    void diagonalCallSpread_returnsNull_whenStrikesMisordered() {
        assertThat(OptionCalendarDiagonalSpreadEngine.diagonalCallSpread(105, 90, 0.25, 0.03, 0.0, 0.25, 4.0)).isNull();
    }
}
