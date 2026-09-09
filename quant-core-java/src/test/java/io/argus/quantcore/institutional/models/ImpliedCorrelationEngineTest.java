package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class ImpliedCorrelationEngineTest {

    @Test
    void recoversTheKnownCorrelation_forAHandConstructedTwoNameIndex() {
        // Two equal-weight (0.5) components, sigma1=0.20, sigma2=0.30, true pairwise rho=0.6.
        // Index variance from the full covariance formula: w1^2*s1^2 + w2^2*s2^2 + 2*w1*w2*rho*s1*s2
        // = 0.25*0.04 + 0.25*0.09 + 2*0.5*0.5*0.6*0.2*0.3 = 0.01 + 0.0225 + 0.018 = 0.0505.
        double indexVariance = 0.25 * 0.04 + 0.25 * 0.09 + 2 * 0.5 * 0.5 * 0.6 * 0.2 * 0.3;
        double indexVol = Math.sqrt(indexVariance);

        ImpliedCorrelationEngine.ComponentVolatility[] components = {
            new ImpliedCorrelationEngine.ComponentVolatility(0.5, 0.20),
            new ImpliedCorrelationEngine.ComponentVolatility(0.5, 0.30)
        };

        Double rho = ImpliedCorrelationEngine.evaluate(indexVol, components);
        assertThat(rho).isNotNull();
        assertThat(rho).isCloseTo(0.6, within(1e-9));
    }

    @Test
    void perfectCorrelation_whenIndexVolEqualsTheWeightedSumOfComponentVols() {
        // rho=1 for every pair means sigma_I = sum(w_i * sigma_i) exactly.
        ImpliedCorrelationEngine.ComponentVolatility[] components = {
            new ImpliedCorrelationEngine.ComponentVolatility(0.6, 0.20),
            new ImpliedCorrelationEngine.ComponentVolatility(0.4, 0.35)
        };
        double indexVol = 0.6 * 0.20 + 0.4 * 0.35;

        Double rho = ImpliedCorrelationEngine.evaluate(indexVol, components);
        assertThat(rho).isNotNull();
        assertThat(rho).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void returnsNullRatherThanFabricating_whenFewerThanTwoComponentsSupplied() {
        ImpliedCorrelationEngine.ComponentVolatility[] components = {
            new ImpliedCorrelationEngine.ComponentVolatility(1.0, 0.20)
        };
        assertThat(ImpliedCorrelationEngine.evaluate(0.20, components)).isNull();
    }
}
