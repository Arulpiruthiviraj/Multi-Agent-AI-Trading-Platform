package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class IndexVolatilityTargetingEngineTest {

    @Test
    void allocatesFullyToTheRiskyAsset_whenCurrentVolEqualsTarget() {
        var result = IndexVolatilityTargetingEngine.evaluate(0.15, 0.15, Double.POSITIVE_INFINITY);
        assertThat(result).isNotNull();
        assertThat(result.riskyAssetWeight()).isCloseTo(1.0, within(1e-9));
        assertThat(result.riskFreeAssetWeight()).isCloseTo(0.0, within(1e-9));
    }

    @Test
    void reducesRiskyWeight_whenCurrentVolExceedsTarget() {
        var result = IndexVolatilityTargetingEngine.evaluate(0.15, 0.30, Double.POSITIVE_INFINITY);
        assertThat(result).isNotNull();
        assertThat(result.riskyAssetWeight()).isCloseTo(0.5, within(1e-9));
    }

    @Test
    void leverageCap_boundsTheRiskyWeight() {
        var result = IndexVolatilityTargetingEngine.evaluate(0.30, 0.10, 2.0); // uncapped would be 3.0
        assertThat(result).isNotNull();
        assertThat(result.riskyAssetWeight()).isCloseTo(2.0, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenCurrentVolatilityIsNotPositive() {
        assertThat(IndexVolatilityTargetingEngine.evaluate(0.15, 0, Double.POSITIVE_INFINITY)).isNull();
    }
}
