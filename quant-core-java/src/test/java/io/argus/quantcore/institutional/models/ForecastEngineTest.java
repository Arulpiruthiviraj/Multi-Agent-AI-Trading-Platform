package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class ForecastEngineTest {

    /** returns = 0.001, 0.002, ..., 0.020 (20 values, a clean symmetric fixture hand-verifiable
     *  without a computer: mean/median/trimmedMean of 1..20 is 10.5, so scaled mean=0.0105). */
    private static double[] symmetricFixture() {
        double[] r = new double[20];
        for (int i = 0; i < 20; i++) r[i] = 0.001 * (i + 1);
        return r;
    }

    @Test
    void computesHandVerifiedMeanMedianTrimmedMeanOnASymmetricFixture() {
        ForecastEngine.ForecastResult result = ForecastEngine.compute(symmetricFixture(), 0);

        assertThat(result.status()).isEqualTo(ForecastEngine.ForecastStatus.VALID);
        assertThat(result.sampleSize()).isEqualTo(20);
        // mean/median of 1..20 is 10.5 -> scaled by 0.001
        assertThat(result.meanReturn()).isCloseTo(0.0105, within(1e-9));
        assertThat(result.medianReturn()).isCloseTo(0.0105, within(1e-9));
        // trim 10% each tail (2 points each side) leaves 3..18, still symmetric around 10.5
        assertThat(result.trimmedMeanReturn()).isCloseTo(0.0105, within(1e-9));
    }

    @Test
    void computesHandVerifiedSampleStdevOnTheSymmetricFixture() {
        // sample variance of 1..20 = n*(n^2-1)/12 / (n-1) = 20*399/12/19 = 35.0 exactly; scaled by 0.001^2
        ForecastEngine.ForecastResult result = ForecastEngine.compute(symmetricFixture(), 0);
        double expectedStdev = Math.sqrt(35.0) * 0.001;
        assertThat(result.stdevReturn()).isCloseTo(expectedStdev, within(1e-9));
    }

    @Test
    void computesHandVerifiedWilsonIntervalAtExactlyFiftyPercentProfitRate() {
        // 10 of 20 returns strictly positive (profit threshold=0), 10 exactly zero (not counted -
        // "> cost", not ">="), giving a clean, hand-computable p=0.5 Wilson interval.
        double[] returns = new double[20];
        for (int i = 0; i < 10; i++) returns[i] = 0.0; // not profitable (not > 0)
        for (int i = 10; i < 20; i++) returns[i] = 0.01; // profitable
        ForecastEngine.ForecastResult result = ForecastEngine.compute(returns, 0);

        assertThat(result.probabilityOfProfit()).isCloseTo(0.5, within(1e-9));
        // Hand-computed 95% Wilson interval for 10/20 (z=1.959963985):
        // denom=1.192075, center=0.5960375, margin=0.239249 -> lower=0.29931, upper=0.70074
        assertThat(result.probabilityOfProfitLower()).isCloseTo(0.29931, within(1e-4));
        assertThat(result.probabilityOfProfitUpper()).isCloseTo(0.70074, within(1e-4));
        assertThat(result.probabilityOfProfitLower()).isLessThan(result.probabilityOfProfit());
        assertThat(result.probabilityOfProfitUpper()).isGreaterThan(result.probabilityOfProfit());
    }

    @Test
    void definesProfitNetOfTransactionCostNotSimplyPositiveReturn() {
        // All 20 returns are +0.0005 (5 bps) - profitable against 0 cost, NOT profitable against
        // a 10 bps assumed round-trip cost. This is the mandate's own explicit definition (item 5):
        // "forward return > estimated transaction costs + slippage", not "forward return > 0".
        double[] returns = new double[20];
        for (int i = 0; i < 20; i++) returns[i] = 0.0005;

        ForecastEngine.ForecastResult zeroCost = ForecastEngine.compute(returns, 0);
        assertThat(zeroCost.probabilityOfProfit()).isEqualTo(1.0);

        ForecastEngine.ForecastResult realCost = ForecastEngine.compute(returns, 10);
        assertThat(realCost.probabilityOfProfit()).isEqualTo(0.0);
        assertThat(realCost.netExpectedReturn()).isCloseTo(0.0005 - 0.0010, within(1e-9));
    }

    @Test
    void reportsInsufficientDataBelowTheMinimumSampleSizeRatherThanFabricating() {
        double[] returns = new double[ForecastEngine.MIN_SAMPLE_SIZE - 1];
        for (int i = 0; i < returns.length; i++) returns[i] = 0.01;

        ForecastEngine.ForecastResult result = ForecastEngine.compute(returns, 0);

        assertThat(result.status()).isEqualTo(ForecastEngine.ForecastStatus.INSUFFICIENT_DATA);
        assertThat(result.sampleSize()).isEqualTo(ForecastEngine.MIN_SAMPLE_SIZE - 1);
        assertThat(result.meanReturn()).isNull();
        assertThat(result.medianReturn()).isNull();
        assertThat(result.trimmedMeanReturn()).isNull();
        assertThat(result.stdevReturn()).isNull();
        assertThat(result.probabilityOfProfit()).isNull();
        assertThat(result.probabilityOfProfitLower()).isNull();
        assertThat(result.netExpectedReturn()).isNull();
    }

    // ---- Adversarial tests (Part 7 item 27) ----

    @Test
    void handlesAnEmptyArrayWithoutThrowing() {
        ForecastEngine.ForecastResult result = ForecastEngine.compute(new double[0], 0);
        assertThat(result.status()).isEqualTo(ForecastEngine.ForecastStatus.INSUFFICIENT_DATA);
        assertThat(result.sampleSize()).isEqualTo(0);
    }

    @Test
    void handlesANullArrayAsEmptyWithoutThrowing() {
        ForecastEngine.ForecastResult result = ForecastEngine.compute(null, 0);
        assertThat(result.status()).isEqualTo(ForecastEngine.ForecastStatus.INSUFFICIENT_DATA);
        assertThat(result.sampleSize()).isEqualTo(0);
    }

    @Test
    void handlesASingleElementArrayAsInsufficientData() {
        ForecastEngine.ForecastResult result = ForecastEngine.compute(new double[]{0.02}, 0);
        assertThat(result.status()).isEqualTo(ForecastEngine.ForecastStatus.INSUFFICIENT_DATA);
        assertThat(result.sampleSize()).isEqualTo(1);
    }

    @Test
    void handlesAllIdenticalReturnsWithZeroStdevAndNoNaN() {
        double[] returns = new double[25];
        for (int i = 0; i < 25; i++) returns[i] = 0.01;
        ForecastEngine.ForecastResult result = ForecastEngine.compute(returns, 0);

        assertThat(result.status()).isEqualTo(ForecastEngine.ForecastStatus.VALID);
        assertThat(result.meanReturn()).isCloseTo(0.01, within(1e-9));
        assertThat(result.medianReturn()).isCloseTo(0.01, within(1e-9));
        assertThat(result.trimmedMeanReturn()).isCloseTo(0.01, within(1e-9));
        assertThat(result.stdevReturn()).isCloseTo(0.0, within(1e-12)); // floating-point noise, not a real spread
        assertThat(result.probabilityOfProfit()).isEqualTo(1.0);
        assertThat(result.meanReturnLower()).isCloseTo(0.01, within(1e-9)); // zero stdev -> zero-width CI
        assertThat(result.meanReturnUpper()).isCloseTo(0.01, within(1e-9));
    }

    @Test
    void doesNotBlowUpOnAnExtremeOutlierAndTrimmedMeanIsLessDistortedThanRawMean() {
        double[] returns = new double[25];
        for (int i = 0; i < 24; i++) returns[i] = 0.001; // 24 tiny, real, well-behaved returns
        returns[24] = 50.0; // one absurd 5000% outlier

        ForecastEngine.ForecastResult result = ForecastEngine.compute(returns, 0);

        assertThat(result.status()).isEqualTo(ForecastEngine.ForecastStatus.VALID);
        assertThat(result.meanReturn()).isGreaterThan(1.0); // raw mean is dominated by the outlier
        assertThat(result.trimmedMeanReturn()).isLessThan(0.01); // trimmed mean is not
        assertThat(Double.isNaN(result.stdevReturn())).isFalse();
        assertThat(Double.isInfinite(result.stdevReturn())).isFalse();
    }

    @Test
    void handlesExtremeNegativeReturnsWithoutProducingAnInvalidProbability() {
        double[] returns = new double[25];
        for (int i = 0; i < 25; i++) returns[i] = -0.30; // catastrophic, uniformly negative sample
        ForecastEngine.ForecastResult result = ForecastEngine.compute(returns, 0);

        assertThat(result.probabilityOfProfit()).isEqualTo(0.0);
        assertThat(result.probabilityOfProfitLower()).isGreaterThanOrEqualTo(0.0);
        assertThat(result.probabilityOfProfitUpper()).isLessThanOrEqualTo(1.0);
        assertThat(result.meanReturn()).isCloseTo(-0.30, within(1e-9));
    }

    @Test
    void wilsonIntervalStaysWithinZeroAndOneAtTheHundredPercentBoundary() {
        double[] returns = new double[30];
        for (int i = 0; i < 30; i++) returns[i] = 0.01; // every single return profitable
        ForecastEngine.ForecastResult result = ForecastEngine.compute(returns, 0);

        assertThat(result.probabilityOfProfit()).isEqualTo(1.0);
        assertThat(result.probabilityOfProfitLower()).isBetween(0.0, 1.0);
        assertThat(result.probabilityOfProfitUpper()).isEqualTo(1.0);
        assertThat(result.probabilityOfProfitLower()).isLessThan(1.0); // real uncertainty even at 100% observed
    }
}
