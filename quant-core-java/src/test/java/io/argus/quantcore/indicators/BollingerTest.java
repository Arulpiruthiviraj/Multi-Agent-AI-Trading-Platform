package io.argus.quantcore.indicators;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/** Expected values captured from the real calcSMA/calcBollingerBands in technicalSignal.ts (2026-08-21). */
class BollingerTest {

    private static final double EPS = 0.0001;

    @Test
    void smaMatchesTypeScriptOnRisingTrendFixture() {
        double[] prices = TestFixtures.risingTrend(60, 100);
        assertThat(MovingAverages.sma(prices, 20)).isCloseTo(115.025, within(EPS));
    }

    @Test
    void bandsMatchTypeScriptOnRisingTrendFixture() {
        double[] prices = TestFixtures.risingTrend(60, 100);
        Bollinger.Bands bands = Bollinger.calculate(prices, 20);
        assertThat(bands.upper()).isCloseTo(118.4230141259271, within(EPS));
        assertThat(bands.lower()).isCloseTo(111.62698587407291, within(EPS));
    }

    @Test
    void smaMatchesTypeScriptOnOscillatingFixture() {
        double[] prices = TestFixtures.oscillating(60, 100);
        assertThat(MovingAverages.sma(prices, 20)).isCloseTo(105.74541000000002, within(EPS));
    }

    @Test
    void bandsMatchTypeScriptOnOscillatingFixture() {
        double[] prices = TestFixtures.oscillating(60, 100);
        Bollinger.Bands bands = Bollinger.calculate(prices, 20);
        assertThat(bands.upper()).isCloseTo(114.17752874321042, within(EPS));
        assertThat(bands.lower()).isCloseTo(97.31329125678963, within(EPS));
    }
}
