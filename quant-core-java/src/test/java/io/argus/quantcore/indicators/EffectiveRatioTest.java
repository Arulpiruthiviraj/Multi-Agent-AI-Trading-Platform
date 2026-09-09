package io.argus.quantcore.indicators;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class EffectiveRatioTest {

    @Test
    void isCloseToPositiveOneForAPureUptrend() {
        // Every bar moves up by exactly 1 - net change equals total absolute change.
        double[] series = new double[11];
        for (int i = 0; i < series.length; i++) series[i] = 100 + i;

        double er = EffectiveRatio.calculate(series, 10);

        assertThat(er).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void isCloseToNegativeOneForAPureDowntrend() {
        double[] series = new double[11];
        for (int i = 0; i < series.length; i++) series[i] = 100 - i;

        double er = EffectiveRatio.calculate(series, 10);

        assertThat(er).isCloseTo(-1.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void isCloseToZeroForPureBackAndForthNoise() {
        // Alternates +1/-1 every bar, ending back near the start - net change ~0, total movement large.
        double[] series = { 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100 };

        double er = EffectiveRatio.calculate(series, 10);

        assertThat(er).isCloseTo(0.0, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void neverLooksPastTheLastSuppliedElement() {
        double[] trendUpThenReverses = new double[12];
        for (int i = 0; i < 11; i++) trendUpThenReverses[i] = 100 + i; // uptrend through index 10
        trendUpThenReverses[11] = 50; // sharp reversal at the very last index

        // Only ask for ER as of index 10 (exclude the reversal) by passing a shorter array.
        double[] excludingReversal = new double[11];
        System.arraycopy(trendUpThenReverses, 0, excludingReversal, 0, 11);
        double er = EffectiveRatio.calculate(excludingReversal, 10);

        assertThat(er).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9)); // unaffected by the reversal, since it wasn't supplied
    }

    @Test
    void returnsNaNRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] series = { 100, 101, 102 };
        assertThat(EffectiveRatio.calculate(series, 10)).isNaN();
    }

    @Test
    void returnsNaNForAnInvalidWindow() {
        double[] series = { 100, 101, 102 };
        assertThat(EffectiveRatio.calculate(series, 0)).isNaN();
        assertThat(EffectiveRatio.calculate(series, -1)).isNaN();
    }

    @Test
    void returnsNaNRatherThanDivideByZeroForAPerfectlyFlatWindow() {
        double[] series = { 100, 100, 100, 100, 100 };
        assertThat(EffectiveRatio.calculate(series, 4)).isNaN();
    }
}
