package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class VolatilityRiskPremiumEngineTest {

    @Test
    void positiveSpread_signalsSellVolatility() {
        var result = VolatilityRiskPremiumEngine.evaluate(20.0, 12.0);
        assertThat(result.spread()).isCloseTo(8.0, within(1e-9));
        assertThat(result.signal()).isEqualTo("SELL_VOLATILITY");
    }

    @Test
    void negativeSpread_signalsNeutral() {
        var result = VolatilityRiskPremiumEngine.evaluate(12.0, 20.0);
        assertThat(result.signal()).isEqualTo("NEUTRAL");
    }

    @Test
    void zeroSpread_signalsNeutral() {
        var result = VolatilityRiskPremiumEngine.evaluate(15.0, 15.0);
        assertThat(result.signal()).isEqualTo("NEUTRAL");
    }
}
