package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class FxDollarCarryEngineTest {

    @Test
    void signalsBuy_whenAverageForwardDiscountIsPositive() {
        var result = FxDollarCarryEngine.evaluate(new double[]{0.02, 0.03, -0.01, 0.01});
        assertThat(result).isNotNull();
        assertThat(result.averageForwardDiscount()).isCloseTo(0.0125, within(1e-9));
        assertThat(result.signal()).isEqualTo("BUY");
    }

    @Test
    void signalsSell_whenAverageForwardDiscountIsNegative() {
        var result = FxDollarCarryEngine.evaluate(new double[]{-0.02, -0.03, 0.01});
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("SELL");
    }

    @Test
    void signalsNeutral_whenAverageIsExactlyZero() {
        var result = FxDollarCarryEngine.evaluate(new double[]{0.02, -0.02});
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("NEUTRAL");
    }

    @Test
    void returnsNullRatherThanFabricating_whenBasketIsEmpty() {
        assertThat(FxDollarCarryEngine.evaluate(new double[0])).isNull();
        assertThat(FxDollarCarryEngine.evaluate(null)).isNull();
    }
}
