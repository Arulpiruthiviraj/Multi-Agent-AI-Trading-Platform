package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.OlsRegression;
import io.argus.quantcore.stats.RollingStatistics;

/**
 * Residual return decomposition: regresses a symbol's returns on a benchmark's returns (real OLS,
 * no duplicate stats), leaving a residual (idiosyncratic) return series. This single decomposition
 * serves "residual momentum" (item 14: is the idiosyncratic component trending), "residual mean
 * reversion" (item 18: is the idiosyncratic component at a statistical extreme), and - added
 * 2026-09-09, catalog #53/#193 - idiosyncratic volatility (Ang, Hodrick, Xing &amp; Zhang, "The
 * Cross-Section of Volatility and Expected Returns," J. Finance 2006) and beta itself as the
 * Frazzini-Pedersen "Betting Against Beta" (2014) low-beta-anomaly input - they are all the same
 * real regression output read four different ways, not four independent models. {@code beta} was
 * already exposed for exactly this reason even before today's addition.
 */
public final class ResidualReturnEngine {

    private ResidualReturnEngine() {
    }

    public record Result(
        double beta,
        double alpha,
        double rSquared,
        double residualZScore,
        double residualMomentum,
        double idiosyncraticVolatility, // stddev of the regression residuals - catalog #53/#193
        String residualMeanReversionSignal // BUY/SELL/NEUTRAL based on residualZScore vs the caller's own threshold - "UNKNOWN" only when threshold isn't supplied
    ) {
    }

    /**
     * @param symbolReturns     chronological simple returns.
     * @param benchmarkReturns  chronological simple returns, same length/alignment (e.g. SPY).
     * @param zWindow           Z-score window over the residual series (e.g. 20).
     * @param momentumWindow    trailing sum window over the residual series (e.g. 10).
     * @param residualZThreshold |Z| at/beyond this triggers residualMeanReversionSignal
     *                          (caller-supplied, not defaulted - "extreme" is a judgment call this
     *                          class won't make for you, matching this session's established
     *                          convention elsewhere, e.g. VixEffectiveRatioFilterEngine).
     * @return null if there isn't enough aligned data to regress and both derived stats.
     */
    public static Result evaluate(double[] symbolReturns, double[] benchmarkReturns, int zWindow, int momentumWindow, double residualZThreshold) {
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

        double meanResidual = 0;
        for (double r : residuals) meanResidual += r;
        meanResidual /= residuals.length;
        double sumSq = 0;
        for (double r : residuals) sumSq += (r - meanResidual) * (r - meanResidual);
        double idiosyncraticVolatility = Math.sqrt(sumSq / residuals.length);

        String signal = z <= -residualZThreshold ? "BUY" : z >= residualZThreshold ? "SELL" : "NEUTRAL";

        return new Result(beta, alpha, reg.rSquared(), z, momentum, idiosyncraticVolatility, signal);
    }

    /** Back-compatible overload for existing callers not using the new mean-reversion signal - a threshold of positive infinity means the signal always reads NEUTRAL. */
    public static Result evaluate(double[] symbolReturns, double[] benchmarkReturns, int zWindow, int momentumWindow) {
        return evaluate(symbolReturns, benchmarkReturns, zWindow, momentumWindow, Double.POSITIVE_INFINITY);
    }
}
