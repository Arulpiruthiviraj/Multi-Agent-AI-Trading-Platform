package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionRatioBackspreadEngineTest {

    @Test
    void callRatioBackspread_computesBoundedMaxLossAtTheShortStrike() {
        var result = OptionRatioBackspreadEngine.evaluate(OptionRatioBackspreadEngine.BackspreadType.CALL_RATIO_BACKSPREAD, 100, 105, 2);
        assertThat(result).isNotNull();
        assertThat(result.maxLoss()).isCloseTo(3, within(1e-9)); // width(5) - netCredit(2)
        assertThat(result.floorProfit()).isCloseTo(2, within(1e-9));
        assertThat(result.breakevenNearSide()).isCloseTo(102, within(1e-9));
        assertThat(result.breakevenFarSide()).isCloseTo(108, within(1e-9)); // 2*105-100-2
    }

    @Test
    void putRatioBackspread_computesBoundedMaxLossAtTheShortStrike() {
        var result = OptionRatioBackspreadEngine.evaluate(OptionRatioBackspreadEngine.BackspreadType.PUT_RATIO_BACKSPREAD, 100, 105, 2);
        assertThat(result).isNotNull();
        assertThat(result.maxLoss()).isCloseTo(3, within(1e-9));
        assertThat(result.floorProfit()).isCloseTo(2, within(1e-9));
        assertThat(result.breakevenNearSide()).isCloseTo(103, within(1e-9)); // 105-2
        assertThat(result.breakevenFarSide()).isCloseTo(97, within(1e-9)); // 2+200-105
    }

    @Test
    void returnsNullRatherThanFabricating_whenNetCreditExceedsWidth() {
        assertThat(OptionRatioBackspreadEngine.evaluate(OptionRatioBackspreadEngine.BackspreadType.CALL_RATIO_BACKSPREAD, 100, 105, 6)).isNull();
    }
}
