package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OptionSyntheticStockEngineTest {

    @Test
    void syntheticLong_boundedRiskAtStrikeMinusNetDebit() {
        var result = OptionSyntheticStockEngine.evaluate(OptionSyntheticStockEngine.Position.SYNTHETIC_LONG, 100, 0, -2);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(102, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(102, within(1e-9));
        assertThat(result.maxReward()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void syntheticShort_boundedRewardAtStrikePlusNetCredit() {
        var result = OptionSyntheticStockEngine.evaluate(OptionSyntheticStockEngine.Position.SYNTHETIC_SHORT, 100, 0, 2);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(102, within(1e-9));
        assertThat(result.maxReward()).isCloseTo(102, within(1e-9));
        assertThat(result.maxRisk()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void splitStrikeLong_boundedRiskAtLowStrikeMinusNetDebit() {
        var result = OptionSyntheticStockEngine.evaluate(OptionSyntheticStockEngine.Position.SPLIT_STRIKE_LONG, 95, 105, -1);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(96, within(1e-9));
        assertThat(result.maxRisk()).isCloseTo(96, within(1e-9));
        assertThat(result.maxReward()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void splitStrikeShort_boundedRewardAtLowStrikePlusNetCredit() {
        var result = OptionSyntheticStockEngine.evaluate(OptionSyntheticStockEngine.Position.SPLIT_STRIKE_SHORT, 95, 105, 1);
        assertThat(result).isNotNull();
        assertThat(result.breakeven()).isCloseTo(106, within(1e-9)); // highStrike + netPremium
        assertThat(result.maxReward()).isCloseTo(96, within(1e-9)); // lowStrike + netPremium
        assertThat(result.maxRisk()).isEqualTo(Double.POSITIVE_INFINITY);
    }

    @Test
    void returnsNullRatherThanFabricating_whenSplitStrikesMisordered() {
        assertThat(OptionSyntheticStockEngine.evaluate(OptionSyntheticStockEngine.Position.SPLIT_STRIKE_LONG, 105, 95, -1)).isNull();
    }
}
