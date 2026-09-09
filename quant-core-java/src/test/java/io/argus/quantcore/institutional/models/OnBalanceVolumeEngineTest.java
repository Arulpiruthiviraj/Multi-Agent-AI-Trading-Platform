package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class OnBalanceVolumeEngineTest {

    @Test
    void obvAccumulatesVolumeOnUpDaysAndSubtractsOnDownDays() {
        double[] closes = { 100, 101, 100, 102 };
        double[] volumes = { 1000, 500, 300, 700 };

        double[] obv = OnBalanceVolumeEngine.calculate(closes, volumes);

        assertThat(obv[0]).isEqualTo(0);
        assertThat(obv[1]).isEqualTo(500);  // up day: +500
        assertThat(obv[2]).isEqualTo(200);  // down day: -300
        assertThat(obv[3]).isEqualTo(900);  // up day: +700
    }

    @Test
    void signalsBullishDivergence_whenPriceFallsButObvRises() {
        // Steep enough decline that the last two heavy-volume up-days still leave the 10-bar
        // price comparison (index 14 vs index 4) net negative, while OBV itself (which only cares
        // about day-to-day direction, not overall magnitude) ends the same window net higher.
        double[] closes = new double[15];
        double[] volumes = new double[15];
        closes[0] = 100;
        volumes[0] = 1000;
        for (int i = 1; i <= 12; i++) {
            closes[i] = closes[i - 1] - 1; // steady decline: 100 -> 88
            volumes[i] = 1000;
        }
        closes[13] = closes[12] + 1; // heavy-volume up-days near the end, still well below index 4's level
        volumes[13] = 5000;
        closes[14] = closes[13] + 1;
        volumes[14] = 5000;

        var result = OnBalanceVolumeEngine.evaluate(closes, volumes, 10);

        assertThat(result).isNotNull();
        assertThat(result.priceChangePct()).isLessThan(0);
        assertThat(result.obvChangePct()).isGreaterThanOrEqualTo(0);
        assertThat(result.divergenceSignal()).isEqualTo("BUY");
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] closes = { 100, 101 };
        double[] volumes = { 100, 200 };
        assertThat(OnBalanceVolumeEngine.evaluate(closes, volumes, 10)).isNull();
    }
}
