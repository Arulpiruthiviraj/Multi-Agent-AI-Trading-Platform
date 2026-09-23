package io.argus.quantcore.institutional.models;

import org.ojalgo.matrix.MatrixR064;
import org.ojalgo.optimisation.Expression;
import org.ojalgo.optimisation.ExpressionsBasedModel;
import org.ojalgo.optimisation.Optimisation;
import org.ojalgo.optimisation.Variable;

import java.util.ArrayList;
import java.util.List;

import static io.argus.quantcore.institutional.models.OjAlgoMatrixSupport.toMatrix;

/**
 * ojAlgo Constrained Portfolio Optimization (2026-09-23, Argus World-Class Open-Source Quant
 * Expansion roadmap, Priority #6 - operator-directed, explicitly sequenced: risk-only objectives
 * FIRST, hard constraints SECOND, candidate-trade impact analysis THIRD, expected-return-aware
 * optimization ONLY AFTER those three - "do not let Claude jump straight to maximize expected
 * return... start with risk structure"). This class implements Layer 1 + Layer 2 of that sequence
 * only: real minimum-variance optimization under real long-only budget and per-symbol concentration
 * constraints. Layer 3 (candidate-trade impact analysis, extending {@link OjAlgoPortfolioRiskEngine})
 * and Layer 4 (net-expected-return-aware optimization, consuming {@code Forecast.netExpectedReturn}
 * from the Net-Expectancy Plumbing roadmap item) are explicitly NOT implemented here - real,
 * tracked follow-ups, not silently assumed.
 *
 * <p>RESEARCH status (see {@code config/engineOwnership.json}): zero HTTP consumer wires this into
 * any live or shadow decision path as of this commit. Advisory only, by construction - this class
 * cannot place an order, cannot call {@code emitTradeIdea}, and has no authority over
 * PositionSizing.ts (the live spine's sole sizing authority) or RiskEngine's real gates. It can only
 * ever produce a research-context weight recommendation a future caller may choose to fold into
 * evidence.
 *
 * <p>Uses ojAlgo's real {@link ExpressionsBasedModel} quadratic-programming solver (verified
 * against ojAlgo 57.3.1's actual source at the exact version tag, not assumed) - not the raw
 * {@link MatrixR064} multiply/transpose {@link OjAlgoPortfolioRiskEngine} already used for
 * (unconstrained) variance/marginal-risk-contribution evidence. This is the first real use of
 * ojAlgo's solver capability in this codebase (added, unused, on 2026-09-23 alongside ta4j).
 */
public final class PortfolioOptimizationEngine {

    private PortfolioOptimizationEngine() {
    }

    public enum OptimizationStatus {
        /** A real, feasible, provably-optimal solution was found. */
        OPTIMAL,
        /** The constraints as given admit no feasible portfolio (e.g. maxWeightPct too tight for n symbols). */
        INFEASIBLE,
        /** The solver ran but did not reach a provably optimal state - never presented as a real answer. */
        FAILED,
        /** Malformed input (non-square covariance, non-positive maxWeightPct, etc.) - checked before any solve attempt. */
        INVALID_INPUT
    }

    public record Result(
        OptimizationStatus status,
        /** Empty (never null, never partially-filled) unless status == OPTIMAL. */
        double[] weights,
        /** Portfolio variance (w^T &Sigma; w) at the solution - NaN unless status == OPTIMAL. */
        double portfolioVariance,
        String detail
    ) {
    }

    /**
     * Real long-only minimum-variance optimization: minimize w'&Sigma;w subject to
     * &sum;w_i = 1 (fully invested, no leverage, no shorting) and 0 &le; w_i &le; maxWeightPct for
     * every symbol i (the same concentration-cap concept as RiskEngine's live gate 17, but this
     * engine has no authority over that real gate - it is a distinct, advisory-only number).
     *
     * @param covariance   symmetric n x n covariance matrix of position returns.
     * @param maxWeightPct per-symbol upper bound in (0, 1]. Checked for structural feasibility
     *                     against n before ever calling the solver (n * maxWeightPct &ge; 1 is
     *                     required for the budget constraint to be reachable at all).
     * @return never null. status distinguishes a real optimum from infeasibility/failure/bad input -
     *         weights/portfolioVariance are only ever real numbers when status == OPTIMAL.
     */
    public static Result minimumVariance(double[][] covariance, double maxWeightPct) {
        int n = covariance.length;
        if (n == 0) {
            return new Result(OptimizationStatus.INVALID_INPUT, new double[0], Double.NaN, "empty covariance");
        }
        for (double[] row : covariance) {
            if (row.length != n) {
                return new Result(OptimizationStatus.INVALID_INPUT, new double[0], Double.NaN, "non-square covariance");
            }
        }
        if (!(maxWeightPct > 0) || maxWeightPct > 1) {
            return new Result(OptimizationStatus.INVALID_INPUT, new double[0], Double.NaN, "maxWeightPct must be in (0, 1]");
        }
        // n * maxWeightPct is the largest total weight the cap allows every symbol to reach
        // simultaneously - below 1 (with a small epsilon for floating-point comparison), the
        // sum(w)=1 budget constraint is structurally unreachable regardless of covariance shape.
        if (n * maxWeightPct < 1.0 - 1e-9) {
            return new Result(OptimizationStatus.INFEASIBLE, new double[0], Double.NaN,
                "maxWeightPct (" + maxWeightPct + ") * n (" + n + ") < 1: budget constraint unreachable under this concentration cap");
        }

        ExpressionsBasedModel model = new ExpressionsBasedModel();
        List<Variable> vars = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            vars.add(model.addVariable("w" + i).lower(0.0).upper(maxWeightPct));
        }

        MatrixR064 sigma = toMatrix(covariance);
        Expression variance = model.addExpression("variance");
        variance.setQuadraticFactors(vars, sigma);
        variance.weight(1.0); // the sole objective term - minimise() minimizes exactly this expression

        Expression budget = model.addExpression("budget");
        for (Variable v : vars) {
            budget.set(v, 1.0);
        }
        budget.level(1.0); // level() sets lower == upper == 1.0, i.e. a real equality constraint

        Optimisation.Result solved = model.minimise();
        if (!solved.getState().isOptimal()) {
            OptimizationStatus status = solved.getState() == Optimisation.State.INFEASIBLE
                ? OptimizationStatus.INFEASIBLE
                : OptimizationStatus.FAILED;
            return new Result(status, new double[0], Double.NaN, "solver state: " + solved.getState());
        }

        double[] weights = new double[n];
        for (int i = 0; i < n; i++) {
            weights[i] = solved.doubleValue(i);
        }
        return new Result(OptimizationStatus.OPTIMAL, weights, solved.getValue(), "OK");
    }
}
