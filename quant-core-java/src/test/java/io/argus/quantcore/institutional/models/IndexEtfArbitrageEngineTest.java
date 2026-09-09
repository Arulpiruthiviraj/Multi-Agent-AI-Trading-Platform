package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class IndexEtfArbitrageEngineTest {

    @Test
    void crossingThreshold_signalsBuyEtf2ShortEtf1() {
        // bid1 >= ask2 * kappa
        var action = IndexEtfArbitrageEngine.evaluate(100.30, 100.35, 100.00, 100.05, 1.002, false, false);
        assertThat(action).isEqualTo(IndexEtfArbitrageEngine.Action.BUY_ETF2_SHORT_ETF1);
    }

    @Test
    void crossingThresholdOtherDirection_signalsBuyEtf1ShortEtf2() {
        var action = IndexEtfArbitrageEngine.evaluate(100.00, 100.05, 100.30, 100.35, 1.002, false, false);
        assertThat(action).isEqualTo(IndexEtfArbitrageEngine.Action.BUY_ETF1_SHORT_ETF2);
    }

    @Test
    void noCrossing_signalsNone() {
        var action = IndexEtfArbitrageEngine.evaluate(100.00, 100.05, 100.01, 100.06, 1.002, false, false);
        assertThat(action).isEqualTo(IndexEtfArbitrageEngine.Action.NONE);
    }

    @Test
    void openPositionThatConverges_signalsLiquidate() {
        var action = IndexEtfArbitrageEngine.evaluate(100.10, 100.15, 100.20, 100.25, 1.002, true, false);
        assertThat(action).isEqualTo(IndexEtfArbitrageEngine.Action.LIQUIDATE);
    }
}
