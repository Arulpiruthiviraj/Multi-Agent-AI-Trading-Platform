package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class OjAlgoPortfolioRiskEngineTest {

    /**
     * Hand-verifiable case: a diagonal (zero-correlation) covariance matrix, so portfolio variance
     * reduces to sum(w_i^2 * var_i) - a closed-form check independent of ojAlgo's own matrix
     * multiply, proving the real linear-algebra result agrees with the textbook formula rather than
     * merely "ojAlgo ran without throwing."
     */
    @Test
    void computesPortfolioVarianceAndMarginalRiskContributionAgainstAHandVerifiableDiagonalCase() {
        double[][] covariance = {
            {0.04, 0.0},
            {0.0, 0.09},
        };
        double[] weights = {0.5, 0.3};

        var result = OjAlgoPortfolioRiskEngine.evaluate(covariance, weights, 0, 0.1, 0.5);

        assertThat(result).isNotNull();
        // 0.5^2 * 0.04 + 0.3^2 * 0.09 = 0.01 + 0.0081
        assertThat(result.currentPortfolioVariance()).isCloseTo(0.0181, within(1e-9));
        // proposed weight[0] = 0.6: 0.6^2 * 0.04 + 0.3^2 * 0.09 = 0.0144 + 0.0081
        assertThat(result.proposedPortfolioVariance()).isCloseTo(0.0225, within(1e-9));
        // RC_0 = w_0 * (Sigma w)_0 = 0.5 * (0.04*0.5) = 0.01; pct = 0.01 / 0.0181
        assertThat(result.marginalRiskContributionPct()).isCloseTo(0.01 / 0.0181, within(1e-9));
        assertThat(result.candidateWeightBefore()).isCloseTo(0.5, within(1e-9));
        assertThat(result.candidateWeightAfter()).isCloseTo(0.6, within(1e-9));
        assertThat(result.exceedsMaxWeight()).isTrue(); // 0.6 > maxWeightPct 0.5
    }

    @Test
    void doesNotFlagExceedsMaxWeightWhenProposedWeightStaysWithinBounds() {
        double[][] covariance = {
            {0.04, 0.0},
            {0.0, 0.09},
        };
        double[] weights = {0.1, 0.3};

        var result = OjAlgoPortfolioRiskEngine.evaluate(covariance, weights, 0, 0.05, 0.5);

        assertThat(result).isNotNull();
        assertThat(result.candidateWeightAfter()).isCloseTo(0.15, within(1e-9));
        assertThat(result.exceedsMaxWeight()).isFalse();
    }

    @Test
    void returnsNullRatherThanFabricatingOnMalformedInput() {
        assertThat(OjAlgoPortfolioRiskEngine.evaluate(new double[0][0], new double[0], 0, 0, 0.2)).isNull();
        assertThat(OjAlgoPortfolioRiskEngine.evaluate(new double[][]{{1, 0}, {0, 1}}, new double[]{0.5, 0.5}, 5, 0, 0.2)).isNull(); // out-of-range index
        assertThat(OjAlgoPortfolioRiskEngine.evaluate(new double[][]{{1, 0, 0}, {0, 1, 0}}, new double[]{0.5, 0.5}, 0, 0, 0.2)).isNull(); // non-square
    }
}
