package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class GapContinuationEngineTest {

    private static double[] constant(int n, double v) {
        double[] a = new double[n];
        java.util.Arrays.fill(a, v);
        return a;
    }

    @Test
    void signalsBuyOnAPositiveGapConfirmedByHeavyVolume() {
        int n = 25;
        double[] opens = constant(n, 100);
        double[] closes = constant(n, 100);
        double[] volumes = constant(n, 1000);
        closes[n - 2] = 100; // prior close
        opens[n - 1] = 105;  // today's open gapped up 5%
        volumes[n - 1] = 3000; // heavy relative volume

        var result = GapContinuationEngine.evaluate(opens, closes, volumes, 20, 1.5);

        assertThat(result).isNotNull();
        assertThat(result.gapPct()).isCloseTo(0.05, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.volumeConfirmed()).isTrue();
        assertThat(result.continuationSignal()).isEqualTo("BUY");
    }

    @Test
    void reportsNeutralWhenTheGapIsNotVolumeConfirmed() {
        int n = 25;
        double[] opens = constant(n, 100);
        double[] closes = constant(n, 100);
        double[] volumes = constant(n, 1000);
        opens[n - 1] = 105;
        volumes[n - 1] = 1000; // ordinary volume, not confirming

        var result = GapContinuationEngine.evaluate(opens, closes, volumes, 20, 1.5);

        assertThat(result.volumeConfirmed()).isFalse();
        assertThat(result.continuationSignal()).isEqualTo("NEUTRAL");
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] opens = { 100, 101 };
        double[] closes = { 100, 101 };
        double[] volumes = { 1000, 1000 };
        assertThat(GapContinuationEngine.evaluate(opens, closes, volumes, 20, 1.5)).isNull();
    }
}
