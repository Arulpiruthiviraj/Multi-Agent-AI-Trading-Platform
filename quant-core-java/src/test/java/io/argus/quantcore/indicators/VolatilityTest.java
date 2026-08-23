package io.argus.quantcore.indicators;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/** Expected values captured from the real TechnicalIndicators.calculateATR in TechnicalIndicators.ts (2026-08-21). */
class VolatilityTest {

    private static final double EPS = 0.0001;

    @Test
    void matchesTypeScriptOnRisingTrendFixture() {
        double[] prices = TestFixtures.risingTrend(60, 100);
        double atr = Volatility.atr(TestFixtures.highs(prices), TestFixtures.lows(prices), prices, 14);
        assertThat(atr).isCloseTo(2.2886910895872177, within(EPS));
    }

    @Test
    void matchesTypeScriptOnOscillatingFixture() {
        double[] prices = TestFixtures.oscillating(60, 100);
        double atr = Volatility.atr(TestFixtures.highs(prices), TestFixtures.lows(prices), prices, 14);
        assertThat(atr).isCloseTo(2.4391551792375035, within(EPS));
    }

    @Test
    void returnsZeroWhenHistoryIsTooShort() {
        double[] prices = TestFixtures.risingTrend(10, 100);
        double atr = Volatility.atr(TestFixtures.highs(prices), TestFixtures.lows(prices), prices, 14);
        assertThat(atr).isZero();
    }
}
