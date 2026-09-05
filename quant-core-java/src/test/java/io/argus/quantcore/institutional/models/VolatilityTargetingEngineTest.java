package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class VolatilityTargetingEngineTest {

    @Test
    void scalesUpAQuietAssetTowardTheTargetVolatility() {
        var result = VolatilityTargetingEngine.evaluate(1000.0, 0.10, 0.20, 5.0);
        assertThat(result).isNotNull();
        assertThat(result.scalingFactor()).isCloseTo(2.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.targetPositionSize()).isCloseTo(2000.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void scalesDownAVolatileAssetTowardTheTargetVolatility() {
        var result = VolatilityTargetingEngine.evaluate(1000.0, 0.40, 0.20, 5.0);
        assertThat(result.scalingFactor()).isCloseTo(0.5, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void neverExceedsTheMaximumScalingFactorEvenForAnExtremelyQuietAsset() {
        var result = VolatilityTargetingEngine.evaluate(1000.0, 0.01, 0.20, 3.0);
        assertThat(result.scalingFactor()).isEqualTo(3.0); // capped, not the raw 20x
    }

    @Test
    void returnsNullForNonPositiveVolatilityInputsRatherThanDividingByZero() {
        assertThat(VolatilityTargetingEngine.evaluate(1000.0, 0.0, 0.20, 3.0)).isNull();
        assertThat(VolatilityTargetingEngine.evaluate(1000.0, 0.10, 0.0, 3.0)).isNull();
    }
}
