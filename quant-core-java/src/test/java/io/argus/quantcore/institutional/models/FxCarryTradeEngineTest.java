package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class FxCarryTradeEngineTest {

    @Test
    void signalsBuy_whenForwardIsAtADiscountToSpot() {
        var result = FxCarryTradeEngine.evaluate(1.30, 1.28);
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("BUY");
        assertThat(result.forwardPremiumOrDiscount()).isLessThan(0);
    }

    @Test
    void signalsSell_whenForwardIsAtAPremiumToSpot() {
        var result = FxCarryTradeEngine.evaluate(1.30, 1.33);
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("SELL");
        assertThat(result.forwardPremiumOrDiscount()).isGreaterThan(0);
    }

    @Test
    void signalsNeutral_whenForwardEqualsSpot() {
        var result = FxCarryTradeEngine.evaluate(1.30, 1.30);
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("NEUTRAL");
        assertThat(result.forwardPremiumOrDiscount()).isCloseTo(0.0, within(1e-12));
    }

    @Test
    void returnsNullRatherThanFabricating_whenSpotIsNotPositive() {
        assertThat(FxCarryTradeEngine.evaluate(0, 1.30)).isNull();
        assertThat(FxCarryTradeEngine.evaluate(-1.0, 1.30)).isNull();
    }

    @Test
    void evaluateFromRates_derivesForwardViaCirpAndMatchesDirectEvaluate() {
        // rd > rf -> CIRP implies F > S -> SELL, matching a positive domestic-foreign rate spread.
        var result = FxCarryTradeEngine.evaluateFromRates(1.30, 0.05, 0.01);
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("SELL");

        double expectedForward = 1.30 * 1.05 / 1.01;
        assertThat(result.forwardRate()).isCloseTo(expectedForward, within(1e-9));
    }

    @Test
    void evaluateFromRates_returnsNull_whenForeignRateIsAtOrBelowNegativeOne() {
        assertThat(FxCarryTradeEngine.evaluateFromRates(1.30, 0.05, -1.0)).isNull();
    }
}
