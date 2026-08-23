package io.argus.quantcore.risk;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Expected values captured from the real src/server/quant/risk/ExpectedValue.ts
 * (scripts/java_parity_fixtures_phase1.ts, 2026-08-21).
 */
class ExpectedValueTest {

    private static final double EPS = 0.0001;

    @Test
    void riskRewardRatioMatchesTypeScript() {
        var result = ExpectedValue.riskRewardRatio(100, 95, 112);
        assertThat(result.ratio()).isCloseTo(2.4, within(EPS));
        assertThat(result.riskPerUnit()).isEqualTo(5);
        assertThat(result.rewardPerUnit()).isEqualTo(12);
    }

    @Test
    void riskRewardRatioIsNullWhenStopEqualsEntry() {
        assertThat(ExpectedValue.riskRewardRatio(100, 100, 112)).isNull();
    }

    @Test
    void expectedValueMatchesTypeScript() {
        var result = ExpectedValue.expectedValue(0.6, 2.4);
        assertThat(result.expectedValueR()).isCloseTo(1.04, within(EPS));
    }

    @Test
    void kellyRefusesBelowMinSampleSize() {
        var result = ExpectedValue.fractionalKelly(0.6, 2.0, 10);
        assertThat(result.statisticallyJustified()).isFalse();
        assertThat(result.suggestedFraction()).isZero();
        assertThat(result.reason()).contains("INSUFFICIENT SAMPLE SIZE");
    }

    @Test
    void kellyJustifiedAndUncappedMatchesTypeScript() {
        var result = ExpectedValue.fractionalKelly(0.55, 1.8, 50);
        assertThat(result.statisticallyJustified()).isTrue();
        assertThat(result.fullKellyFraction()).isCloseTo(0.3, within(EPS));
        assertThat(result.suggestedFraction()).isCloseTo(0.075, within(EPS));
    }

    @Test
    void kellyJustifiedAndCappedMatchesTypeScript() {
        var result = ExpectedValue.fractionalKelly(0.7, 3.0, 50);
        assertThat(result.statisticallyJustified()).isTrue();
        assertThat(result.fullKellyFraction()).isCloseTo(0.6, within(EPS));
        assertThat(result.suggestedFraction()).isCloseTo(0.1, within(EPS)); // capped at MAX_KELLY_FRACTION_OF_CAPITAL
    }

    @Test
    void kellyNonPositiveEdgeMatchesTypeScript() {
        var result = ExpectedValue.fractionalKelly(0.3, 1.0, 50);
        assertThat(result.statisticallyJustified()).isTrue();
        assertThat(result.fullKellyFraction()).isCloseTo(-0.4, within(EPS));
        assertThat(result.suggestedFraction()).isZero();
        assertThat(result.reason()).contains("non-positive");
    }
}
