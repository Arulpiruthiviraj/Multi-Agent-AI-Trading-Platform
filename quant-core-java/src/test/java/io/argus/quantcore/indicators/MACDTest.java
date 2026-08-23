package io.argus.quantcore.indicators;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/** Expected values captured from the real src/server/engines/MACDEngine.ts (2026-08-21). */
class MACDTest {

    private static final double EPS = 0.0001;

    @Test
    void matchesTypeScriptOnRisingTrendFixture() {
        double[] prices = TestFixtures.risingTrend(60, 100);
        MACD.Result result = new MACD(12, 26, 9).calculate(prices);

        assertThat(result.macd()).isCloseTo(1.9214937564667878, within(EPS));
        assertThat(result.signal()).isCloseTo(1.9270719433877903, within(EPS));
        assertThat(result.histogram()).isCloseTo(-0.005578186921002537, within(EPS));
    }

    @Test
    void matchesTypeScriptOnOscillatingFixture() {
        double[] prices = TestFixtures.oscillating(60, 100);
        MACD.Result result = new MACD(12, 26, 9).calculate(prices);

        assertThat(result.macd()).isCloseTo(-1.3192766205103652, within(EPS));
        assertThat(result.signal()).isCloseTo(-0.594871045330273, within(EPS));
        assertThat(result.histogram()).isCloseTo(-0.7244055751800922, within(EPS));
    }

    @Test
    void returnsAllZeroWhenHistoryIsShorterThanLongPeriod() {
        double[] prices = TestFixtures.risingTrend(10, 100);
        MACD.Result result = new MACD(12, 26, 9).calculate(prices);

        assertThat(result.macd()).isZero();
        assertThat(result.signal()).isZero();
        assertThat(result.histogram()).isZero();
    }
}
