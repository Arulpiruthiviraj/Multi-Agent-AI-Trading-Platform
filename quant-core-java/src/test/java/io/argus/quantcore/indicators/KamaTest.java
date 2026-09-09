package io.argus.quantcore.indicators;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class KamaTest {

    @Test
    void tracksPriceFarMoreCloselyThanASlowFixedPeriodEmaWould_duringAStrongCleanTrend() {
        // A clean uptrend has ER near 1 throughout, so KAMA should use its fast smoothing constant
        // and track price much more closely than a slow, fixed-period EMA (period 50, the same
        // "slow" period KAMA itself falls back to when ER is 0) would - both are EMA-style filters
        // under continuous linear drift, so neither tracks price exactly (a real, constant lag is
        // mathematically expected for any such filter), but KAMA's lag should be far smaller.
        double[] prices = new double[60];
        for (int i = 0; i < prices.length; i++) prices[i] = 100 + i;

        double[] kama = Kama.calculate(prices, 12, 5, 50);
        double[] slowEma = MovingAverages.ema(prices, 50);

        double lastPrice = prices[prices.length - 1];
        double kamaLag = lastPrice - kama[kama.length - 1];
        double slowEmaLag = lastPrice - slowEma[slowEma.length - 1];
        assertThat(kamaLag).isLessThan(slowEmaLag);
    }

    @Test
    void staysCloseToItsSeed_smoothing_duringChoppyBackAndForthMovement() {
        // Pure back-and-forth noise (alternating +-1 around a level) has ER = 0 exactly whenever
        // the window is even (v[t-1] and v[t-1-window] land on the same phase of the oscillation),
        // so KAMA should use the slow smoothing constant throughout and barely move from its own
        // seed value, in sharp contrast to the +-1 swings in the raw price itself.
        double[] prices = new double[60];
        for (int i = 0; i < prices.length; i++) prices[i] = 100 + (i % 2 == 0 ? 1 : -1);

        double[] kama = Kama.calculate(prices, 12, 5, 50);

        double seed = prices[0];
        for (int i = 20; i < kama.length; i++) {
            assertThat(kama[i]).isCloseTo(seed, org.assertj.core.data.Offset.offset(1.0));
        }
    }

    @Test
    void seedsWithTheFirstPriceRatherThanFabricatingAnEarlierValue() {
        double[] prices = { 105, 106, 107 };
        double[] kama = Kama.calculate(prices, 12, 5, 50);
        assertThat(kama[0]).isEqualTo(105.0);
    }

    @Test
    void returnsAnEmptyArrayRatherThanThrowingForEmptyInput() {
        assertThat(Kama.calculate(new double[0], 12, 5, 50)).isEmpty();
    }
}
