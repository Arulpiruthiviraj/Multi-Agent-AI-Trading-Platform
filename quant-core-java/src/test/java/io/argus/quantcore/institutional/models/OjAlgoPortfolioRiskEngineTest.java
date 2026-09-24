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

    /**
     * Hand-verifiable full-portfolio risk-contribution decomposition: same diagonal (zero-correlation)
     * two-asset case as above, but checking the Euler decomposition holds for BOTH symbols at once
     * (sum(RC_i) == portfolioVariance exactly), not just the single-candidate slice.
     */
    @Test
    void computesRiskContributionsForEverySymbolAndTheyEulerDecomposeToPortfolioVariance() {
        double[][] covariance = {
            {0.04, 0.0},
            {0.0, 0.09},
        };
        double[] weights = {0.5, 0.3};

        var result = OjAlgoPortfolioRiskEngine.riskContributions(covariance, weights);

        assertThat(result).isNotNull();
        // portfolioVariance = 0.5^2*0.04 + 0.3^2*0.09 = 0.01 + 0.0081 = 0.0181
        assertThat(result.portfolioVariance()).isCloseTo(0.0181, within(1e-9));
        // RC_0 = w_0 * (Sigma w)_0 = 0.5 * (0.04*0.5) = 0.01
        // RC_1 = w_1 * (Sigma w)_1 = 0.3 * (0.09*0.3) = 0.3 * 0.027 = 0.0081
        assertThat(result.riskContributions()[0]).isCloseTo(0.01, within(1e-9));
        assertThat(result.riskContributions()[1]).isCloseTo(0.0081, within(1e-9));
        // Euler decomposition: RC_0 + RC_1 == portfolioVariance exactly (diagonal case, no cross terms)
        assertThat(result.riskContributions()[0] + result.riskContributions()[1])
            .isCloseTo(result.portfolioVariance(), within(1e-9));
        assertThat(result.riskContributionPct()[0]).isCloseTo(0.01 / 0.0181, within(1e-9));
        assertThat(result.riskContributionPct()[1]).isCloseTo(0.0081 / 0.0181, within(1e-9));
        assertThat(result.riskContributionPct()[0] + result.riskContributionPct()[1]).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void riskContributionsWithCrossCorrelationStillEulerDecomposesExactly() {
        // Off-diagonal correlated case: closed-form Euler decomposition property (sum RC_i ==
        // portfolioVariance) must still hold exactly even with real cross-terms, proving this isn't
        // an artifact of the diagonal special case above.
        double[][] covariance = {
            {0.04, 0.012},
            {0.012, 0.09},
        };
        double[] weights = {0.6, 0.4};

        var result = OjAlgoPortfolioRiskEngine.riskContributions(covariance, weights);

        assertThat(result).isNotNull();
        // portfolioVariance = w'Sigma w = 0.6^2*0.04 + 2*0.6*0.4*0.012 + 0.4^2*0.09
        //                   = 0.0144 + 0.00576 + 0.0144 = 0.03456
        assertThat(result.portfolioVariance()).isCloseTo(0.03456, within(1e-9));
        double sumRc = result.riskContributions()[0] + result.riskContributions()[1];
        assertThat(sumRc).isCloseTo(result.portfolioVariance(), within(1e-9));
        double sumPct = result.riskContributionPct()[0] + result.riskContributionPct()[1];
        assertThat(sumPct).isCloseTo(1.0, within(1e-9));
    }

    @Test
    void riskContributionsReturnsNullOnMalformedInput() {
        assertThat(OjAlgoPortfolioRiskEngine.riskContributions(new double[0][0], new double[0])).isNull();
        assertThat(OjAlgoPortfolioRiskEngine.riskContributions(
            new double[][]{{1, 0, 0}, {0, 1, 0}}, new double[]{0.5, 0.5})).isNull(); // non-square
    }
}
