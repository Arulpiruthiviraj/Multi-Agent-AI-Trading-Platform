package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionRatioSpreadEngineTest {

    @Test
    void ratioCallSpread_hasUnlimitedUpsideLossAndBoundedDownsideLoss() {
        var result = OptionRatioSpreadEngine.evaluate(OptionRatioSpreadEngine.SpreadType.RATIO_CALL_SPREAD, 100, 105, 1);
        assertThat(result).isNotNull();
        assertThat(result.maxProfit()).isCloseTo(4, within(1e-9)); // width(5) - netCost(1)
        assertThat(result.maxLossUpside()).isEqualTo(Double.POSITIVE_INFINITY);
        assertThat(result.maxLossDownside()).isCloseTo(1, within(1e-9));
        assertThat(result.breakevenLower()).isCloseTo(101, within(1e-9));
        assertThat(result.breakevenUpper()).isCloseTo(109, within(1e-9)); // 2*105-100-1
    }

    @Test
    void ratioPutSpread_hasBoundedLossOnBothSides() {
        var result = OptionRatioSpreadEngine.evaluate(OptionRatioSpreadEngine.SpreadType.RATIO_PUT_SPREAD, 100, 105, 1);
        assertThat(result).isNotNull();
        assertThat(result.maxProfit()).isCloseTo(4, within(1e-9));
        assertThat(result.maxLossUpside()).isCloseTo(1, within(1e-9)); // bounded, unlike the call variant
        assertThat(result.maxLossDownside()).isCloseTo(96, within(1e-9)); // netCost + 2*100 - 105
        assertThat(result.breakevenUpper()).isCloseTo(104, within(1e-9)); // 105 - 1
    }

    @Test
    void returnsNullRatherThanFabricating_whenStrikesMisordered() {
        assertThat(OptionRatioSpreadEngine.evaluate(OptionRatioSpreadEngine.SpreadType.RATIO_CALL_SPREAD, 105, 100, 1)).isNull();
    }
}
