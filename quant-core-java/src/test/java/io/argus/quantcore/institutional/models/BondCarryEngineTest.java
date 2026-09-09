package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class BondCarryEngineTest {

    @Test
    void positiveRollDown_onADownwardSlopingYieldAtTheShorterMaturity() {
        // Curve is upward-sloping in maturity, so the yield at the shorter point (T-dt) is LOWER
        // than the current yield at T -> rolling down means yields fall as maturity shortens ->
        // positive roll-down gain: Croll = -ModD*(R(t,T-dt) - R(t,T)) = -ModD*(lower - higher) > 0.
        var result = BondCarryEngine.evaluate(0.04, 0.03, 5.0, 1.0 / 12);
        assertThat(result).isNotNull();
        assertThat(result.rollDown()).isGreaterThan(0);
    }

    @Test
    void yieldAccrual_isSimplyYieldTimesHorizon() {
        var result = BondCarryEngine.evaluate(0.04, 0.03, 5.0, 1.0 / 12);
        assertThat(result).isNotNull();
        assertThat(result.yieldAccrual()).isCloseTo(0.04 * (1.0 / 12), within(1e-9));
    }

    @Test
    void totalCarry_isTheSumOfYieldAccrualAndRollDown() {
        var result = BondCarryEngine.evaluate(0.04, 0.03, 5.0, 1.0 / 12);
        assertThat(result).isNotNull();
        assertThat(result.totalCarry()).isCloseTo(result.yieldAccrual() + result.rollDown(), within(1e-12));
    }

    @Test
    void flatYieldCurve_hasZeroRollDown() {
        var result = BondCarryEngine.evaluate(0.04, 0.04, 5.0, 1.0 / 12);
        assertThat(result).isNotNull();
        assertThat(result.rollDown()).isCloseTo(0.0, within(1e-12));
    }

    @Test
    void returnsNullRatherThanFabricating_whenHorizonIsNotPositive() {
        assertThat(BondCarryEngine.evaluate(0.04, 0.03, 5.0, 0)).isNull();
    }
}
