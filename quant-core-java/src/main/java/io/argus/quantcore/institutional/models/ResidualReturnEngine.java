package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.OlsRegression;
import io.argus.quantcore.stats.RollingStatistics;

/**
 * Residual return decomposition: regresses a symbol's returns on a benchmark's returns (real OLS,
 * no duplicate stats), leaving a residual (idiosyncratic) return series. This single decomposition
 * serves BOTH "residual momentum" (item 14: is the idiosyncratic component trending) and "residual
 * mean reversion" (item 18: is the idiosyncratic component at a statistical extreme) - they are
 * the same real regression output interpreted two ways, not two independent models.
 */
public final class ResidualReturnEngine {

    private ResidualReturnEngine() {
    }

    public record Result(
        double beta,
        double alpha,
        double rSquared,
        double residualZScore,
        double residualMomentum
    ) {
    }

    /**
     * @param symbolReturns     chronological simple returns.
     * @param benchmarkReturns  chronological simple returns, same length/alignment (e.g. SPY).
     * @param zWindow           Z-score window over the residual series (e.g. 20).
     * @param momentumWindow    trailing sum window over the residual series (e.g. 10).
     * @return null if there isn't enough aligned data to regress and both derived stats.
     */
    public static Result evaluate(double[] symbolReturns, double[] benchmarkReturns, int zWindow, int momentumWindow) {
        int n = symbolReturns.length;
        if (benchmarkReturns.length != n || n <= Math.max(zWindow, momentumWindow) + 2) {
            return null;
        }
        double[][] predictors = new double[n][1];
        for (int i = 0; i < n; i++) predictors[i][0] = benchmarkReturns[i];

        OlsRegression.Result reg = OlsRegression.fit(predictors, symbolReturns, true);
        if (reg == null) {
            return null;
        }
        double alpha = reg.coefficients()[0];
        double beta = reg.coefficients()[1];
        double[] residuals = reg.residuals();

        Double z = RollingStatistics.zScore(residuals, zWindow);
        if (z == null || residuals.length < momentumWindow) {
            return null;
        }
        double momentum = 0;
        for (int i = residuals.length - momentumWindow; i < residuals.length; i++) {
            momentum += residuals[i];
        }

        return new Result(beta, alpha, reg.rSquared(), z, momentum);
    }
}
