package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class FiftyTwoWeekHighMomentumEngineTest {

    @Test
    void signalsBuyWhenCloseIsAtTheFiftyTwoWeekHighItself() {
        double[] closes = new double[260];
        for (int i = 0; i < 260; i++) closes[i] = 100 + i * 0.1; // strictly rising -> last close is always the high

        var result = FiftyTwoWeekHighMomentumEngine.evaluate(closes, 0.95);

        assertThat(result).isNotNull();
        assertThat(result.nearnessRatio()).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.nearHigh()).isTrue();
        assertThat(result.signal()).isEqualTo("BUY");
    }

    @Test
    void reportsNeutralWhenFarBelowTheFiftyTwoWeekHigh() {
        double[] closes = new double[260];
        for (int i = 0; i < 260; i++) closes[i] = 100;
        closes[100] = 200; // one spike far in the past sets a high well above the current level

        var result = FiftyTwoWeekHighMomentumEngine.evaluate(closes, 0.95);

        assertThat(result.nearnessRatio()).isLessThan(0.95);
        assertThat(result.nearHigh()).isFalse();
        assertThat(result.signal()).isEqualTo("NEUTRAL");
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100, 101, 102 };
        assertThat(FiftyTwoWeekHighMomentumEngine.evaluate(closes, 252, 0.95)).isNull();
    }
}
