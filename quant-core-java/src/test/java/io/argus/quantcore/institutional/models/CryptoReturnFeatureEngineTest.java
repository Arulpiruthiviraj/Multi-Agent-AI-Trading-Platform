package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class CryptoReturnFeatureEngineTest {

    @Test
    void computeReturns_computesSimplePeriodicReturns() {
        double[] closes = {100.0, 110.0, 99.0};
        double[] returns = CryptoReturnFeatureEngine.computeReturns(closes);

        assertThat(returns).hasSize(2);
        assertThat(returns[0]).isCloseTo(0.10, within(1e-9));
        assertThat(returns[1]).isCloseTo(-0.10, within(1e-9));
    }

    @Test
    void computeReturns_returnsEmptyArray_forASingleClose() {
        assertThat(CryptoReturnFeatureEngine.computeReturns(new double[]{100.0})).isEmpty();
    }

    @Test
    void computeNormalizedReturn_isPositive_whenTheLatestReturnExceedsItsTrailingWindowMean() {
        // Trailing window is flat near 0, then a sharp positive return at the scored index.
        double[] returns = {0.001, -0.001, 0.0005, -0.0005, 0.05};
        Double z = CryptoReturnFeatureEngine.computeNormalizedReturn(returns, 4, 4);

        assertThat(z).isNotNull();
        assertThat(z).isGreaterThan(0);
    }

    @Test
    void computeNormalizedReturn_windowExcludesTheScoredIndexItself() {
        // If the window included returns[4], a huge outlier would inflate its own stddev and
        // suppress the z-score. Verify the window is computed from returns[0..3] only, not [0..4].
        // (A perfectly-constant window like [0.01,0.01,0.01,0.01] would be a degenerate,
        // zero-variance case - correctly null, not a bug - so this uses a window with real variance.)
        double[] returns2 = {0.01, 0.02, 0.01, 0.02, 100.0};
        Double z2 = CryptoReturnFeatureEngine.computeNormalizedReturn(returns2, 4, 4);
        double expectedMean = (0.01 + 0.02 + 0.01 + 0.02) / 4;
        double expectedStdDev = Math.sqrt(((0.01 - expectedMean) * (0.01 - expectedMean) * 2
            + (0.02 - expectedMean) * (0.02 - expectedMean) * 2) / 4);
        double expectedZ = (100.0 - expectedMean) / expectedStdDev;
        assertThat(z2).isCloseTo(expectedZ, within(1e-9));
    }

    @Test
    void computeNormalizedReturn_returnsNullRatherThanFabricating_whenNotEnoughHistory() {
        double[] returns = {0.01, 0.02};
        assertThat(CryptoReturnFeatureEngine.computeNormalizedReturn(returns, 1, 4)).isNull();
    }

    @Test
    void computeNormalizedReturn_returnsNull_whenWindowHasZeroVariance() {
        double[] returns = {0.01, 0.01, 0.01, 0.01, 0.05};
        assertThat(CryptoReturnFeatureEngine.computeNormalizedReturn(returns, 4, 4)).isNull();
    }

    @Test
    void computeEma_weightsTheMostRecentReturnInTheWindowTheMost() {
        // A step function: old returns all 0, most recent (closest to index) is 1.0.
        // With high decay (low lambda), the EMA should be dominated by that most-recent value.
        double[] returns = {0.0, 0.0, 0.0, 1.0}; // index=4 scores window [0..3], most recent = returns[3] = 1.0
        Double ema = CryptoReturnFeatureEngine.computeEma(returns, 4, 0.1, 4);

        assertThat(ema).isNotNull();
        assertThat(ema).isGreaterThan(0.5); // dominated by the most recent (highest-weight) point
    }

    @Test
    void computeEma_convergesToSimpleAverage_asLambdaApproachesOne() {
        double[] returns = {0.01, 0.02, 0.03, 0.04};
        Double ema = CryptoReturnFeatureEngine.computeEma(returns, 4, 0.999, 4);
        double simpleAverage = (0.01 + 0.02 + 0.03 + 0.04) / 4;

        assertThat(ema).isNotNull();
        assertThat(ema).isCloseTo(simpleAverage, within(0.01));
    }

    @Test
    void computeEma_returnsNullRatherThanFabricating_whenLambdaIsOutOfRange() {
        double[] returns = {0.01, 0.02, 0.03, 0.04};
        assertThat(CryptoReturnFeatureEngine.computeEma(returns, 4, 0.0, 4)).isNull();
        assertThat(CryptoReturnFeatureEngine.computeEma(returns, 4, 1.0, 4)).isNull();
    }

    @Test
    void computeEmsd_isZero_whenEveryReturnInTheWindowIsIdentical() {
        double[] returns = {0.02, 0.02, 0.02, 0.02};
        Double emsd = CryptoReturnFeatureEngine.computeEmsd(returns, 4, 0.5, 4);

        assertThat(emsd).isNotNull();
        assertThat(emsd).isCloseTo(0.0, within(1e-9));
    }

    @Test
    void computeEmsd_isPositive_whenReturnsVary() {
        double[] returns = {0.01, -0.01, 0.02, -0.02};
        Double emsd = CryptoReturnFeatureEngine.computeEmsd(returns, 4, 0.5, 4);

        assertThat(emsd).isNotNull();
        assertThat(emsd).isGreaterThan(0.0);
    }

    @Test
    void computeRsi_isOne_whenEveryReturnInTheWindowIsPositive() {
        double[] returns = {0.01, 0.02, 0.03, 0.04};
        Double rsi = CryptoReturnFeatureEngine.computeRsi(returns, 4, 4);

        assertThat(rsi).isNotNull();
        assertThat(rsi).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void computeRsi_isZero_whenEveryReturnInTheWindowIsNegative() {
        double[] returns = {-0.01, -0.02, -0.03, -0.04};
        Double rsi = CryptoReturnFeatureEngine.computeRsi(returns, 4, 4);

        assertThat(rsi).isNotNull();
        assertThat(rsi).isCloseTo(0.0, within(1e-9));
    }

    @Test
    void computeRsi_isHalf_whenGainsAndLossesAreEqualInMagnitude() {
        double[] returns = {0.02, -0.02, 0.03, -0.03};
        Double rsi = CryptoReturnFeatureEngine.computeRsi(returns, 4, 4);

        assertThat(rsi).isNotNull();
        assertThat(rsi).isCloseTo(0.5, within(1e-9));
    }

    @Test
    void computeRsi_returnsNullRatherThanFabricating_whenEveryReturnInWindowIsExactlyZero() {
        double[] returns = {0.0, 0.0, 0.0, 0.0};
        assertThat(CryptoReturnFeatureEngine.computeRsi(returns, 4, 4)).isNull();
    }

    @Test
    void lambdaFromTau_matchesFootnote224sOwnFormula() {
        assertThat(CryptoReturnFeatureEngine.lambdaFromTau(4)).isCloseTo(3.0 / 5.0, within(1e-9));
        assertThat(CryptoReturnFeatureEngine.lambdaFromTau(12)).isCloseTo(11.0 / 13.0, within(1e-9));
    }
}
