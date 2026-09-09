package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class VixEffectiveRatioFilterEngineTest {

    @Test
    void suppressesTradingWhenVixIsTrendingStronglyUpAndDirectionIsSuppressAbove() {
        // VIX rising every bar - a pure uptrend has ER = 1.0.
        double[] vixCloses = new double[11];
        for (int i = 0; i < vixCloses.length; i++) vixCloses[i] = 15 + i;

        var result = VixEffectiveRatioFilterEngine.evaluate(
            vixCloses, 10, VixEffectiveRatioFilterEngine.GateDirection.SUPPRESS_ABOVE, 0.1);

        assertThat(result.computable()).isTrue();
        assertThat(result.vixEffectiveRatio()).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.shouldSuppressTrading()).isTrue();
    }

    @Test
    void doesNotSuppressWhenVixIsCalmAndDirectionIsSuppressAbove() {
        // Alternating back-and-forth VIX (no real trend) - ER near 0, well under a 0.1 threshold.
        double[] vixCloses = { 15, 15.5, 15, 15.5, 15, 15.5, 15, 15.5, 15, 15.5, 15 };

        var result = VixEffectiveRatioFilterEngine.evaluate(
            vixCloses, 10, VixEffectiveRatioFilterEngine.GateDirection.SUPPRESS_ABOVE, 0.1);

        assertThat(result.shouldSuppressTrading()).isFalse();
    }

    @Test
    void suppressesTradingWhenVixIsTrendingStronglyDownAndDirectionIsSuppressBelow() {
        // Mirrors the SH510050 case in the source paper, where the useful signal ran the other way.
        double[] vixCloses = new double[8];
        for (int i = 0; i < vixCloses.length; i++) vixCloses[i] = 20 - i;

        var result = VixEffectiveRatioFilterEngine.evaluate(
            vixCloses, 7, VixEffectiveRatioFilterEngine.GateDirection.SUPPRESS_BELOW, -0.1);

        assertThat(result.vixEffectiveRatio()).isCloseTo(-1.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.shouldSuppressTrading()).isTrue();
    }

    @Test
    void neverSuppressesWhenTheRatioIsNotComputable_insufficientHistory() {
        double[] vixCloses = { 15, 16 };

        var result = VixEffectiveRatioFilterEngine.evaluate(
            vixCloses, 10, VixEffectiveRatioFilterEngine.GateDirection.SUPPRESS_ABOVE, 0.1);

        assertThat(result.computable()).isFalse();
        assertThat(result.vixEffectiveRatio()).isNaN();
        // Fail open (never block trading) rather than fail closed on missing data - this filter
        // is an optional overlay, not a safety gate; RiskEngine's own gates are the safety layer.
        assertThat(result.shouldSuppressTrading()).isFalse();
    }
}
