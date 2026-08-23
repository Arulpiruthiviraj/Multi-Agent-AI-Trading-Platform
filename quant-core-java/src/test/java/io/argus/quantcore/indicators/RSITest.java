package io.argus.quantcore.indicators;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Expected values captured by running the real src/server/engines/RSIEngine.ts against the
 * identical fixtures produced by TestFixtures (see scripts/_java_parity_fixtures.ts, run
 * 2026-08-21) — not hand-derived, so this is genuine cross-language parity, not "should agree
 * by inspection."
 */
class RSITest {

    private static final double EPS = 0.0001;

    @Test
    void matchesTypeScriptOnRisingTrendFixture() {
        double[] prices = TestFixtures.risingTrend(60, 100);
        double rsi = new RSI(14).calculate(prices);
        assertThat(rsi).isCloseTo(60.89954720191467, within(EPS));
    }

    @Test
    void matchesTypeScriptOnOscillatingFixture() {
        double[] prices = TestFixtures.oscillating(60, 100);
        double rsi = new RSI(14).calculate(prices);
        assertThat(rsi).isCloseTo(44.19666291537066, within(EPS));
    }

    @Test
    void returnsNeutral50WhenHistoryIsTooShort() {
        double[] prices = TestFixtures.risingTrend(10, 100);
        double rsi = new RSI(14).calculate(prices);
        assertThat(rsi).isEqualTo(50);
    }
}
