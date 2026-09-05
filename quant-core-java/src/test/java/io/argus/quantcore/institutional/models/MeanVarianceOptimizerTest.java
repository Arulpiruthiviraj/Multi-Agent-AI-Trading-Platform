package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MeanVarianceOptimizerTest {

    @Test
    void minimumVarianceWeightsSumToOneAndFavorTheLowerVarianceAsset() {
        // Two uncorrelated assets: asset 0 has much higher variance than asset 1.
        double[][] cov = {
            { 0.04, 0.0 },
            { 0.0, 0.01 }
        };
        var result = MeanVarianceOptimizer.minimumVariancePortfolio(cov);
        assertThat(result).isNotNull();
        assertThat(result.weights()[0] + result.weights()[1]).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.weights()[1]).isGreaterThan(result.weights()[0]); // lower-variance asset gets more weight
    }

    @Test
    void tangencyPortfolioWeightsSumToOneAndTiltTowardHigherExpectedReturn() {
        double[][] cov = {
            { 0.02, 0.0 },
            { 0.0, 0.02 }
        };
        double[] expectedReturns = { 0.10, 0.03 }; // asset 0 has a much better risk-adjusted return
        var result = MeanVarianceOptimizer.tangencyPortfolio(cov, expectedReturns, 0.01);
        assertThat(result).isNotNull();
        assertThat(result.weights()[0] + result.weights()[1]).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-9));
        assertThat(result.weights()[0]).isGreaterThan(result.weights()[1]);
        assertThat(result.expectedReturn()).isGreaterThan(0.03);
    }

    @Test
    void returnsNullForASingularCovarianceMatrix() {
        // Two identical rows -> singular.
        double[][] cov = {
            { 0.01, 0.01 },
            { 0.01, 0.01 }
        };
        assertThat(MeanVarianceOptimizer.minimumVariancePortfolio(cov)).isNull();
    }
}
