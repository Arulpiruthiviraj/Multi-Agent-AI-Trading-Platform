package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class RiskParityOptimizerTest {

    @Test
    void givesEqualWeightWhenAssetsAreIdenticalAndUncorrelated() {
        double[][] cov = {
            { 0.02, 0.0 },
            { 0.0, 0.02 }
        };
        var result = RiskParityOptimizer.solve(cov, 200, 1e-10);
        assertThat(result).isNotNull();
        assertThat(result.weights()[0]).isCloseTo(0.5, org.assertj.core.data.Offset.offset(0.01));
        assertThat(result.weights()[1]).isCloseTo(0.5, org.assertj.core.data.Offset.offset(0.01));
    }

    @Test
    void convergesToEqualRealRiskContributionsForAssetsWithDifferentVariance() {
        // Asset 0 has 4x the variance of asset 1 - a real risk-parity solution must under-weight it.
        double[][] cov = {
            { 0.04, 0.0 },
            { 0.0, 0.01 }
        };
        var result = RiskParityOptimizer.solve(cov, 500, 1e-8);
        assertThat(result.converged()).isTrue();
        assertThat(result.weights()[0]).isLessThan(result.weights()[1]);
        // The whole point of risk parity: each asset's real risk contribution should be equal.
        assertThat(result.riskContributions()[0]).isCloseTo(result.riskContributions()[1], org.assertj.core.data.Offset.offset(0.01));
    }

    @Test
    void weightsAlwaysSumToOne() {
        double[][] cov = {
            { 0.05, 0.01, 0.0 },
            { 0.01, 0.03, 0.005 },
            { 0.0, 0.005, 0.02 }
        };
        var result = RiskParityOptimizer.solve(cov, 300, 1e-10);
        double sum = result.weights()[0] + result.weights()[1] + result.weights()[2];
        assertThat(sum).isCloseTo(1.0, org.assertj.core.data.Offset.offset(1e-6));
    }

    @Test
    void returnsNullForAnEmptyCovarianceMatrix() {
        double[][] cov = new double[0][0];
        assertThat(RiskParityOptimizer.solve(cov, 100, 1e-6)).isNull();
    }
}
