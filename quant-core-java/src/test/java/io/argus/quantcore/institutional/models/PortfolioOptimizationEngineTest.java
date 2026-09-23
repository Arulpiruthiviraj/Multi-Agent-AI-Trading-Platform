package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Deterministic, hand-solvable portfolio-optimization test suite (roadmap Priority #6, Layer 1/2
 * only - risk-only minimum-variance objective plus real budget/concentration constraints). Every
 * expected value below is derived from closed-form portfolio theory, not from re-running the
 * solver and asserting whatever it happens to produce - the same "golden vector" discipline this
 * codebase already applies to RSI/MACD (RSIEngineTest.java, MACDEngineTest.java).
 */
class PortfolioOptimizationEngineTest {

    @Test
    void twoAssetUncorrelatedDiagonalCovariance_matchesClosedFormInverseVarianceWeighting() {
        // sigma1^2=0.04, sigma2^2=0.09, zero correlation. Closed form for the unconstrained
        // (long-only, no binding cap) two-asset minimum-variance portfolio:
        // w1* = (1/sigma1^2) / (1/sigma1^2 + 1/sigma2^2) = 25 / (25 + 11.1111) = 0.692308
        // w2* = 1 - w1* = 0.307692
        // sigma_p^2 = (sigma1^2 * sigma2^2) / (sigma1^2 + sigma2^2) = 0.0036 / 0.13 = 0.0276923
        double[][] covariance = {
            {0.04, 0.0},
            {0.0, 0.09},
        };
        var result = PortfolioOptimizationEngine.minimumVariance(covariance, 1.0);

        assertThat(result.status()).isEqualTo(PortfolioOptimizationEngine.OptimizationStatus.OPTIMAL);
        assertThat(result.weights()).hasSize(2);
        assertThat(result.weights()[0]).isCloseTo(0.692308, within(1e-4));
        assertThat(result.weights()[1]).isCloseTo(0.307692, within(1e-4));
        assertThat(result.weights()[0] + result.weights()[1]).isCloseTo(1.0, within(1e-9)); // real budget constraint
        assertThat(result.portfolioVariance()).isCloseTo(0.0276923, within(1e-5));
    }

    @Test
    void singleSymbolConcentrationBreach_capsAtMaxWeightExactlyOnTheBoundary() {
        // Same two-asset case as above, but maxWeightPct=0.5 - below asset 1's natural 0.6923
        // unconstrained optimum. With exactly 2 assets and budget=1, the only feasible point at
        // this cap is w=[0.5, 0.5] (asset 1 pinned at its cap, asset 2 forced to absorb the rest,
        // itself exactly at its own cap too) - an exact, not approximate, boundary solution.
        double[][] covariance = {
            {0.04, 0.0},
            {0.0, 0.09},
        };
        var result = PortfolioOptimizationEngine.minimumVariance(covariance, 0.5);

        assertThat(result.status()).isEqualTo(PortfolioOptimizationEngine.OptimizationStatus.OPTIMAL);
        assertThat(result.weights()[0]).isCloseTo(0.5, within(1e-6));
        assertThat(result.weights()[1]).isCloseTo(0.5, within(1e-6));
        // Real, verifiable consequence: this constrained variance must be WORSE (higher) than the
        // unconstrained 0.0276923 from the unrestricted case above - the cap has a real cost.
        double constrainedVariance = 0.5 * 0.5 * 0.04 + 0.5 * 0.5 * 0.09; // = 0.01 + 0.0225 = 0.0325
        assertThat(result.portfolioVariance()).isCloseTo(constrainedVariance, within(1e-6));
        assertThat(result.portfolioVariance()).isGreaterThan(0.0276923);
    }

    @Test
    void threeAssetEquicorrelatedPortfolio_matchesTheKnownEqualWeightSymmetryResult() {
        // A well-known closed-form result in portfolio theory: for n assets with IDENTICAL variance
        // and IDENTICAL pairwise correlation (an "equicorrelated" set), the minimum-variance
        // portfolio is always the equal-weighted one (1/n each), regardless of the specific
        // correlation value (as long as rho < 1) - a direct consequence of the problem's symmetry
        // under permutation of the assets. sigma^2=0.04 for all three, rho=0.3 ->
        // covariance_offdiag = rho * sigma^2 = 0.3 * 0.04 = 0.012.
        double var = 0.04;
        double cov = 0.3 * var;
        double[][] covariance = {
            {var, cov, cov},
            {cov, var, cov},
            {cov, cov, var},
        };
        var result = PortfolioOptimizationEngine.minimumVariance(covariance, 1.0);

        assertThat(result.status()).isEqualTo(PortfolioOptimizationEngine.OptimizationStatus.OPTIMAL);
        assertThat(result.weights()).hasSize(3);
        for (double w : result.weights()) {
            assertThat(w).isCloseTo(1.0 / 3.0, within(1e-4));
        }
        // sigma_p^2 for equal weights = var/n + (n-1)/n * cov = 0.04/3 + 2/3*0.012 = 0.013333 + 0.008 = 0.021333
        assertThat(result.portfolioVariance()).isCloseTo(0.021333, within(1e-4));
    }

    @Test
    void nearSingularPerfectlyCorrelatedCovariance_staysOptimalWithTheCorrectConstantVariance() {
        // Two assets with identical variance and PERFECT correlation (off-diagonal == diagonal) ->
        // the 2x2 covariance matrix is singular (rank 1). Real, derivable closed-form property: for
        // ANY long-only combination on the budget simplex (w1+w2=1, w1,w2>=0), portfolio variance
        // is IDENTICAL: w'Sigma*w = sigma^2 * (w1+w2)^2 = sigma^2 * 1 = sigma^2 = 0.04, since every
        // entry of Sigma equals sigma^2 here. The optimal WEIGHT SPLIT is non-unique (any point on
        // the simplex is equally optimal), but the objective value at the solution is not - this
        // test asserts the real, solver-independent invariant (variance == 0.04) rather than a
        // specific weight split, and confirms the solver does not crash or report FAILED on a
        // singular (positive-semidefinite, not positive-definite) covariance matrix.
        double[][] covariance = {
            {0.04, 0.04},
            {0.04, 0.04},
        };
        var result = PortfolioOptimizationEngine.minimumVariance(covariance, 1.0);

        assertThat(result.status()).isEqualTo(PortfolioOptimizationEngine.OptimizationStatus.OPTIMAL);
        assertThat(result.weights()[0] + result.weights()[1]).isCloseTo(1.0, within(1e-6));
        assertThat(result.weights()[0]).isBetween(-1e-6, 1.0 + 1e-6);
        assertThat(result.portfolioVariance()).isCloseTo(0.04, within(1e-5));
    }

    @Test
    void structurallyInfeasibleConcentrationCap_reportsInfeasibleBeforeEverCallingTheSolver() {
        // 3 assets, maxWeightPct=0.2 -> largest reachable total weight is 3*0.2=0.6 < 1. The
        // sum(w)=1 budget constraint can never be satisfied under this cap, regardless of
        // covariance shape - checked structurally, never sent to the solver to fail expensively.
        double[][] covariance = {
            {0.04, 0.0, 0.0},
            {0.0, 0.04, 0.0},
            {0.0, 0.0, 0.04},
        };
        var result = PortfolioOptimizationEngine.minimumVariance(covariance, 0.2);

        assertThat(result.status()).isEqualTo(PortfolioOptimizationEngine.OptimizationStatus.INFEASIBLE);
        assertThat(result.weights()).isEmpty();
        assertThat(result.portfolioVariance()).isNaN();
    }

    @Test
    void malformedInput_returnsInvalidInputRatherThanThrowingOrFabricating() {
        assertThat(PortfolioOptimizationEngine.minimumVariance(new double[0][0], 1.0).status())
            .isEqualTo(PortfolioOptimizationEngine.OptimizationStatus.INVALID_INPUT);

        // non-square
        double[][] nonSquare = { {0.04, 0.0, 0.0}, {0.0, 0.04, 0.0} };
        assertThat(PortfolioOptimizationEngine.minimumVariance(nonSquare, 1.0).status())
            .isEqualTo(PortfolioOptimizationEngine.OptimizationStatus.INVALID_INPUT);

        double[][] valid = { {0.04, 0.0}, {0.0, 0.09} };
        assertThat(PortfolioOptimizationEngine.minimumVariance(valid, 0.0).status())
            .isEqualTo(PortfolioOptimizationEngine.OptimizationStatus.INVALID_INPUT);
        assertThat(PortfolioOptimizationEngine.minimumVariance(valid, 1.5).status())
            .isEqualTo(PortfolioOptimizationEngine.OptimizationStatus.INVALID_INPUT);
    }
}
