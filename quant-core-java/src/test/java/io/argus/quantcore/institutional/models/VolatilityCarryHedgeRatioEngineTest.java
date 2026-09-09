package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class VolatilityCarryHedgeRatioEngineTest {

    @Test
    void simpleHedgeRatio_matchesTheClosedFormFormula() {
        Double h = VolatilityCarryHedgeRatioEngine.simpleHedgeRatio(0.85, 0.60, 0.40);
        assertThat(h).isNotNull();
        assertThat(h).isCloseTo(0.85 * 0.60 / 0.40, within(1e-9));
    }

    @Test
    void simpleHedgeRatio_returnsNullRatherThanFabricating_whenHedgeVolIsNotPositive() {
        assertThat(VolatilityCarryHedgeRatioEngine.simpleHedgeRatio(0.85, 0.60, 0)).isNull();
    }

    @Test
    void basketHedgeWeights_matchesHandComputedExample_forADiagonalCovarianceMatrix() {
        // Two uncorrelated hedge instruments: sigma1=0.2, sigma2=0.3, so C = diag(0.04, 0.09).
        double[][] covariance = {
            {0.04, 0.0},
            {0.0, 0.09}
        };
        double hedgedVolatility = 0.5;
        double[] correlations = {0.6, 0.4};

        double[] weights = VolatilityCarryHedgeRatioEngine.basketHedgeWeights(hedgedVolatility, covariance, correlations);

        assertThat(weights).isNotNull();
        // w_i = sigma_X * (1/sigma_i^2) * sigma_i * rho_i = sigma_X * rho_i / sigma_i (diagonal case).
        assertThat(weights[0]).isCloseTo(0.5 * 0.6 / 0.2, within(1e-6)); // = 1.5
        assertThat(weights[1]).isCloseTo(0.5 * 0.4 / 0.3, within(1e-6)); // = 0.6667
    }

    @Test
    void basketHedgeWeights_returnsNullRatherThanFabricating_whenDimensionsMismatch() {
        double[][] covariance = {{0.04, 0.0}, {0.0, 0.09}};
        double[] correlations = {0.6};
        assertThat(VolatilityCarryHedgeRatioEngine.basketHedgeWeights(0.5, covariance, correlations)).isNull();
    }
}
