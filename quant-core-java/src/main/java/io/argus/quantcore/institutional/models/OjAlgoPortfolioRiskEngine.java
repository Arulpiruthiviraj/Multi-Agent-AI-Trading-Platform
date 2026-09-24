package io.argus.quantcore.institutional.models;

import org.ojalgo.matrix.MatrixR064;

import static io.argus.quantcore.institutional.models.OjAlgoMatrixSupport.toColumnVector;
import static io.argus.quantcore.institutional.models.OjAlgoMatrixSupport.toMatrix;

/**
 * Multi-Library Java Quant Decision Intelligence Integration (2026-09-23), Phase 4: ojAlgo as a
 * real numerical/linear-algebra backend for portfolio-risk EVIDENCE - never an authoritative order
 * quantity. PositionSizing (TypeScript, the live spine) remains the sole authority over what
 * actually gets sized and sent to OMS; this engine can only ever produce advisory numbers that a
 * future caller may choose to fold into evidence, exactly like every other RESEARCH-status engine
 * in this directory. RESEARCH status (see config/engineOwnership.json): zero HTTP consumer wires
 * this into any live or shadow decision path as of this commit.
 *
 * <p>Computes real portfolio variance (w^T &Sigma; w) and per-symbol marginal risk contribution
 * (RC_i = w_i * (&Sigma;w)_i, the standard Qian (2006) risk-budgeting decomposition where
 * &sum;RC_i = total portfolio variance exactly) via ojAlgo's {@link MatrixR064} dense matrix
 * algebra - a genuine capability gap this module did not previously have a tested, general
 * matrix-multiply/transpose implementation for. Does not attempt mean-variance optimization or any
 * constrained solve in this pass (ojAlgo's LP/QP/MIP solvers are a distinct, larger follow-up, not
 * implemented here) - this is deliberately scoped to the smaller, immediately verifiable
 * evidence-record shape from the integration mandate's own {@code PortfolioOptimizationEvidence}
 * example (marginal risk contribution, concentration impact), not the full optimizer.
 */
public final class OjAlgoPortfolioRiskEngine {

    private OjAlgoPortfolioRiskEngine() {
    }

    public record Result(
        double currentPortfolioVariance,
        double proposedPortfolioVariance,
        double marginalRiskContributionPct,
        double candidateWeightBefore,
        double candidateWeightAfter,
        boolean exceedsMaxWeight
    ) {
    }

    /**
     * @param covariance           symmetric n x n covariance matrix of position returns, symbol order matching {@code weights}.
     * @param weights              current portfolio weights (fraction of equity), same order/length as {@code covariance}.
     * @param candidateIndex       index into {@code weights}/{@code covariance} of the symbol being evaluated.
     * @param candidateWeightDelta proposed additive change to that symbol's weight (negative for a SELL/reduce).
     * @param maxWeightPct         a concentration cap to flag against (advisory only - this engine has no authority over RiskEngine gate 17, the real, live symbol_concentration gate).
     * @return null on malformed input (non-square matrix, dimension mismatch, out-of-range index) - never a fabricated result.
     */
    public static Result evaluate(double[][] covariance, double[] weights, int candidateIndex,
                                   double candidateWeightDelta, double maxWeightPct) {
        int n = weights.length;
        if (n == 0 || covariance.length != n || candidateIndex < 0 || candidateIndex >= n) {
            return null;
        }
        for (double[] row : covariance) {
            if (row.length != n) {
                return null;
            }
        }

        MatrixR064 sigma = toMatrix(covariance);
        MatrixR064 w = toColumnVector(weights);
        double currentVariance = portfolioVariance(sigma, w);

        double[] proposedWeights = weights.clone();
        proposedWeights[candidateIndex] += candidateWeightDelta;
        MatrixR064 proposedW = toColumnVector(proposedWeights);
        double proposedVariance = portfolioVariance(sigma, proposedW);

        MatrixR064 sigmaW = sigma.multiply(w);
        double riskContribution = weights[candidateIndex] * sigmaW.doubleValue(candidateIndex, 0);
        double marginalRiskContributionPct = currentVariance > 0 ? riskContribution / currentVariance : 0.0;

        double candidateWeightAfter = proposedWeights[candidateIndex];
        return new Result(
            currentVariance,
            proposedVariance,
            marginalRiskContributionPct,
            weights[candidateIndex],
            candidateWeightAfter,
            Math.abs(candidateWeightAfter) > maxWeightPct
        );
    }

    private static double portfolioVariance(MatrixR064 sigma, MatrixR064 w) {
        MatrixR064 result = w.transpose().multiply(sigma).multiply(w);
        return result.doubleValue(0, 0);
    }

    public record RiskContributionResult(
        double portfolioVariance,
        /** RC_i = w_i * (&Sigma;w)_i for every symbol, same order as the input weights. &sum;RC_i == portfolioVariance exactly (Euler decomposition). */
        double[] riskContributions,
        /** RC_i / portfolioVariance for every symbol - sums to 1.0. */
        double[] riskContributionPct
    ) {
    }

    /**
     * Full-portfolio risk-contribution decomposition (Qian 2006 Euler decomposition), generalizing
     * the single-candidate {@code marginalRiskContributionPct} field in {@link #evaluate} to every
     * symbol at once. Foundational building block for risk-parity / maximum-diversification analysis
     * (Argus World-Class Open-Source Quant Expansion roadmap Priority #6, Layer 2 follow-up) - not
     * itself a diversification ratio or risk-parity optimizer, both of which remain unimplemented.
     * RESEARCH status, same advisory-only contract as every method in this class: no order authority,
     * no PositionSizing/RiskEngine/OMS access.
     *
     * @param covariance symmetric n x n covariance matrix of position returns.
     * @param weights    portfolio weights (fraction of equity), same order/length as {@code covariance}.
     * @return null on malformed input (non-square matrix, dimension mismatch) - never a fabricated result.
     */
    public static RiskContributionResult riskContributions(double[][] covariance, double[] weights) {
        int n = weights.length;
        if (n == 0 || covariance.length != n) {
            return null;
        }
        for (double[] row : covariance) {
            if (row.length != n) {
                return null;
            }
        }

        MatrixR064 sigma = toMatrix(covariance);
        MatrixR064 w = toColumnVector(weights);
        double variance = portfolioVariance(sigma, w);
        MatrixR064 sigmaW = sigma.multiply(w);

        double[] rc = new double[n];
        double[] rcPct = new double[n];
        for (int i = 0; i < n; i++) {
            rc[i] = weights[i] * sigmaW.doubleValue(i, 0);
            rcPct[i] = variance > 0 ? rc[i] / variance : 0.0;
        }
        return new RiskContributionResult(variance, rc, rcPct);
    }
}
