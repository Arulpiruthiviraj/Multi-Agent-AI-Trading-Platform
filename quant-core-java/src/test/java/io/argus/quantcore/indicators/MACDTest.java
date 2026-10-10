package io.argus.quantcore.indicators;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Expected values captured from the real src/server/engines/MACDEngine.ts.
 * RE-CAPTURED 2026-10-10: the 2026-09-22 TS fix (SMA-seeded EMA warmup, backfilled) changed
 * MACDEngine's own output — the old 2026-08-21 expectations pinned the pre-fix first-price
 * seed, a documented real defect on the TS side (MACDEngine.ts's own comment: live-measured
 * 17.5% macdSignal divergence). These values come from the CURRENT TS engine run against the
 * same risingTrend/oscillating fixture formulas TestFixtures uses, so parity means matching
 * the live agent's actual output, not the stale fixture.
 */
class MACDTest {

    private static final double EPS = 0.0001;

    @Test
    void matchesTypeScriptOnRisingTrendFixture() {
        double[] prices = TestFixtures.risingTrend(60, 100);
        MACD.Result result = new MACD(12, 26, 9).calculate(prices);

        assertThat(result.macd()).isCloseTo(1.9600576558314913, within(EPS));
        assertThat(result.signal()).isCloseTo(1.983064512650258, within(EPS));
        assertThat(result.histogram()).isCloseTo(-0.023006856818766686, within(EPS));
    }

    @Test
    void matchesTypeScriptOnOscillatingFixture() {
        double[] prices = TestFixtures.oscillating(60, 100);
        MACD.Result result = new MACD(12, 26, 9).calculate(prices);

        assertThat(result.macd()).isCloseTo(-1.3907622647112987, within(EPS));
        assertThat(result.signal()).isCloseTo(-0.7004649547489791, within(EPS));
        assertThat(result.histogram()).isCloseTo(-0.6902973099623196, within(EPS));
    }

    @Test
    void returnsAllZeroWhenHistoryIsShorterThanLongPeriod() {
        double[] prices = TestFixtures.risingTrend(10, 100);
        MACD.Result result = new MACD(12, 26, 9).calculate(prices);

        assertThat(result.macd()).isZero();
        assertThat(result.signal()).isZero();
        assertThat(result.histogram()).isZero();
    }

    /**
     * Regression pin for the 2026-09-22 seeding fix (Java defect hunt 2026-10-10): the EMA
     * series must be SMA-seeded with a backfilled warmup, NOT first-price-seeded. With
     * prices 1..10 and period 3, the seed is (1+2+3)/3 = 2.0, so emas[0..2] are all 2.0 —
     * the old first-price convention would have produced emas[0] = 1.0 here.
     */
    @Test
    void emaSeriesUsesSmaSeededWarmupNotFirstPriceSeed() {
        double[] prices = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
        double[] emas = MovingAverages.ema(prices, 3);

        assertThat(emas).hasSize(10);
        // Backfilled warmup: all equal to the SMA of the first 3 prices.
        assertThat(emas[0]).isCloseTo(2.0, within(1e-12));
        assertThat(emas[1]).isCloseTo(2.0, within(1e-12));
        assertThat(emas[2]).isCloseTo(2.0, within(1e-12));
        // Recursive leg: emas[3] = (4 - 2) * (2/4) + 2 = 3.0.
        assertThat(emas[3]).isCloseTo(3.0, within(1e-12));
        // Short series: warmupLen = min(period, length) seeds the whole series.
        double[] shortEmas = MovingAverages.ema(new double[]{10, 20}, 5);
        assertThat(shortEmas[0]).isCloseTo(15.0, within(1e-12));
        assertThat(shortEmas[1]).isCloseTo(15.0, within(1e-12));
    }

    /** Empty input returns an empty series (matches TS calcEMA's [] case), never throws. */
    @Test
    void emaSeriesOnEmptyInputReturnsEmptyArray() {
        assertThat(MovingAverages.ema(new double[0], 12)).isEmpty();
    }

    /** sma on empty input returns 0 (matches TechnicalIndicators.calculateSMA's `|| 0`), never throws. */
    @Test
    void smaOnEmptyInputReturnsZero() {
        assertThat(MovingAverages.sma(new double[0], 20)).isZero();
    }
}
