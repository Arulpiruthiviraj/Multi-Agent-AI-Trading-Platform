package io.argus.quantcore.institutional.math;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class EwmaCovarianceTest {

    @Test
    void varianceMatchesHandComputedRecursion() {
        double[] returns = {0.01, -0.02, 0.015, 0.03};
        double lambda = 0.9;
        // Seed = equal-weighted sample variance of the whole series, then recurse.
        double mean = (0.01 - 0.02 + 0.015 + 0.03) / 4;
        double seed = 0;
        for (double r : returns) seed += (r - mean) * (r - mean);
        seed /= 4;
        double expected = seed;
        for (int t = 1; t < returns.length; t++) {
            expected = lambda * expected + (1 - lambda) * returns[t - 1] * returns[t - 1];
        }
        Double actual = EwmaCovariance.variance(returns, lambda);
        assertThat(actual).isNotNull();
        assertThat(actual).isCloseTo(expected, org.assertj.core.data.Offset.offset(1e-12));
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
