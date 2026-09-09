package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class VixFuturesBasisEngineTest {

    @Test
    void deepBackwardation_signalsOpenLong() {
        // basis very negative -> daily roll well below -0.10
        var result = VixFuturesBasisEngine.evaluate(15.0, 20.0, 20, false, false); // basis=-5, roll=-0.25
        assertThat(result).isNotNull();
        assertThat(result.basis()).isCloseTo(-5.0, within(1e-9));
        assertThat(result.dailyRoll()).isCloseTo(-0.25, within(1e-9));
        assertThat(result.signal()).isEqualTo(VixFuturesBasisEngine.Signal.OPEN_LONG);
    }

    @Test
    void deepContango_signalsOpenShort() {
        var result = VixFuturesBasisEngine.evaluate(25.0, 20.0, 20, false, false); // basis=5, roll=0.25
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo(VixFuturesBasisEngine.Signal.OPEN_SHORT);
    }

    @Test
    void openLongPosition_closesWhenBasisMeanReverts() {
        var result = VixFuturesBasisEngine.evaluate(19.5, 20.0, 50, true, false); // roll = -0.01, > -0.05
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo(VixFuturesBasisEngine.Signal.CLOSE_LONG);
    }

    @Test
    void openShortPosition_closesWhenBasisMeanReverts() {
        var result = VixFuturesBasisEngine.evaluate(20.5, 20.0, 50, false, true); // roll = 0.01, < 0.05
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo(VixFuturesBasisEngine.Signal.CLOSE_SHORT);
    }

    @Test
    void midRangeBasis_withNoOpenPosition_signalsNone() {
        var result = VixFuturesBasisEngine.evaluate(20.02, 20.0, 20, false, false); // roll = 0.001
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo(VixFuturesBasisEngine.Signal.NONE);
    }

    @Test
    void returnsNullRatherThanFabricating_whenDaysToSettlementIsNotPositive() {
        assertThat(VixFuturesBasisEngine.evaluate(20, 20, 0, false, false)).isNull();
    }
}
