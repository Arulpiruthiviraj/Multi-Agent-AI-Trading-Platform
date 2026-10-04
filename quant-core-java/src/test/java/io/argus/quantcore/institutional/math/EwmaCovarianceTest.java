package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class EwmaCovarianceTest {

    @Test
    void varianceMatchesHandComputedRecursion() {
        double[] returns = {0.01, -0.02, 0.015, 0.03};
        double lambda = 0.9;
        // Seed = equal-weighted sample variance of the whole series, then recurse over EVERY
        // observation including the last (P1-9, 2026-10-04: this hand-computed expectation
        // previously replicated the exact off-by-one it should have been catching - t ran
        // 1..length-1, never incorporating returns[length-1] - so this test validated the bug
        // rather than the real recursion. t now runs 1..length inclusive, matching the production
        // fix.
        double mean = (0.01 - 0.02 + 0.015 + 0.03) / 4;
        double seed = 0;
        for (double r : returns) seed += (r - mean) * (r - mean);
        seed /= 4;
        double expected = seed;
        for (int t = 1; t <= returns.length; t++) {
            expected = lambda * expected + (1 - lambda) * returns[t - 1] * returns[t - 1];
        }
        Double actual = EwmaCovariance.variance(returns, lambda);
        assertThat(actual).isNotNull();
        assertThat(actual).isCloseTo(expected, org.assertj.core.data.Offset.offset(1e-12));
    }

    @Test
    void lastObservationMeasurablyMovesTheFinalVarianceEstimate() {
        // P1-9 regression: on a 5-element series, replacing only the FINAL return with a much
        // larger shock must change the result. Before the fix, returns[length-1] was never read
        // by the recursion at all, so this assertion would fail (both series produced an
        // identical estimate regardless of the last value).
        double[] baseline = {0.01, -0.02, 0.015, 0.03, 0.005};
        double[] finalShock = {0.01, -0.02, 0.015, 0.03, 0.50};
        double lambda = 0.94;
        Double baseVariance = EwmaCovariance.variance(baseline, lambda);
        Double shockedVariance = EwmaCovariance.variance(finalShock, lambda);
        assertThat(baseVariance).isNotNull();
        assertThat(shockedVariance).isNotNull();
        assertThat(shockedVariance).isNotCloseTo(baseVariance, org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void lastObservationMeasurablyMovesTheFinalCovarianceMatrix() {
        double[] a = {0.01, -0.02, 0.015, 0.03, 0.005};
        double[] bBaseline = {0.02, -0.01, 0.01, 0.02, 0.004};
        double[] bShocked = {0.02, -0.01, 0.01, 0.02, 0.60};
        double lambda = 0.94;
        double[][] base = EwmaCovariance.covarianceMatrix(new double[][]{a, bBaseline}, lambda);
        double[][] shocked = EwmaCovariance.covarianceMatrix(new double[][]{a, bShocked}, lambda);
        assertThat(base).isNotNull();
        assertThat(shocked).isNotNull();
        assertThat(shocked[0][1]).isNotCloseTo(base[0][1], org.assertj.core.data.Offset.offset(1e-9));
    }

    @Test
    void covarianceMatrixIsSymmetricWithMatchingDiagonalVariance() {
        double[] a = {0.01, -0.02, 0.015, 0.03, -0.01};
        double[] b = {0.02, -0.01, 0.01, 0.02, -0.02};
        double[][] cov = EwmaCovariance.covarianceMatrix(new double[][]{a, b}, 0.94);
        assertThat(cov).isNotNull();
        assertThat(cov[0][1]).isCloseTo(cov[1][0], org.assertj.core.data.Offset.offset(1e-12));
        Double varA = EwmaCovariance.variance(a, 0.94);
        assertThat(cov[0][0]).isCloseTo(varA, org.assertj.core.data.Offset.offset(1e-12));
    }

    @Test
    void returnsNullForRaggedInput() {
        double[][] ragged = {{0.01, 0.02}, {0.01, 0.02, 0.03}};
        assertThat(EwmaCovariance.covarianceMatrix(ragged, 0.94)).isNull();
    }

    @Test
    void returnsNullForTooShortASeries() {
        assertThat(EwmaCovariance.variance(new double[]{0.01}, 0.94)).isNull();
    }
}
