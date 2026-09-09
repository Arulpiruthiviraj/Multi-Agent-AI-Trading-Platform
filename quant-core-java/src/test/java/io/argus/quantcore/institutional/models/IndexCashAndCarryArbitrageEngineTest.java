package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class IndexCashAndCarryArbitrageEngineTest {

    @Test
    void richFutures_signalsSellFuturesBuyCash() {
        // Fair price near spot*e^(rT); an observed price well above it is "rich".
        var result = IndexCashAndCarryArbitrageEngine.evaluate(4000, 5, 0.05, 0.25, 4100, 0.001);
        assertThat(result).isNotNull();
        assertThat(result.basis()).isGreaterThan(0);
        assertThat(result.signal()).isEqualTo("SELL_FUTURES_BUY_CASH");
    }

    @Test
    void cheapFutures_signalsBuyFuturesSellCash() {
        var result = IndexCashAndCarryArbitrageEngine.evaluate(4000, 5, 0.05, 0.25, 3900, 0.001);
        assertThat(result).isNotNull();
        assertThat(result.basis()).isLessThan(0);
        assertThat(result.signal()).isEqualTo("BUY_FUTURES_SELL_CASH");
    }

    @Test
    void smallBasisWithinThreshold_signalsNeutral() {
        var fair = IndexCashAndCarryArbitrageEngine.evaluate(4000, 5, 0.05, 0.25, 4000, 0.05);
        assertThat(fair).isNotNull();
        var result = IndexCashAndCarryArbitrageEngine.evaluate(4000, 5, 0.05, 0.25, fair.fairFuturesPrice() + 0.1, 0.05);
        assertThat(result).isNotNull();
        assertThat(result.signal()).isEqualTo("NEUTRAL");
    }

    @Test
    void returnsNullRatherThanFabricating_whenSpotIsNotPositive() {
        assertThat(IndexCashAndCarryArbitrageEngine.evaluate(0, 5, 0.05, 0.25, 4000, 0.001)).isNull();
    }
}
