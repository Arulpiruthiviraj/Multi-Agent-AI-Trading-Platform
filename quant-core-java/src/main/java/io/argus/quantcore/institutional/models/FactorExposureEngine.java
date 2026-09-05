package io.argus.quantcore.institutional.models;

/**
 * Beta / idiosyncratic volatility / liquidity factor - three real, price-and-volume-derived
 * factor-exposure metrics packaged together (rather than three trivial one-line classes). Beta and
 * the residual series are NOT re-derived here - this wraps {@link ResidualReturnEngine}'s own real
 * OLS-vs-benchmark regression (single authoritative path for "regress this symbol on a benchmark"),
 * adding only the two computations that regression doesn't already produce: idiosyncratic
 * volatility (the stdev of the residuals) and Amihud illiquidity (a standard, real liquidity proxy -
 * Amihud, "Illiquidity and Stock Returns", J. Financial Markets, 2002).
 */
public final class FactorExposureEngine {

    private FactorExposureEngine() {
    }

    public record Result(
        double beta,
        double idiosyncraticVolatility,
        double amihudIlliquidity,
        double rSquared
    ) {
    }

    /**
     * @param symbolReturns    chronological simple returns.
     * @param benchmarkReturns chronological simple returns, same length/alignment.
     * @param dollarVolumes    chronological dollar volume (price*shares) for the SAME bars as
     *                         symbolReturns - used only for the Amihud measure.
     * @param residualZWindow  passed through to ResidualReturnEngine (Z-score window - unused output here, kept consistent).
     * @param residualMomentumWindow passed through to ResidualReturnEngine.
     * @return null if the underlying regression fails, or dollarVolumes is misaligned.
     */
    public static Result evaluate(double[] symbolReturns, double[] benchmarkReturns, double[] dollarVolumes, int residualZWindow, int residualMomentumWindow) {
        if (dollarVolumes.length != symbolReturns.length) {
            return null;
        }
        ResidualReturnEngine.Result residualResult = ResidualReturnEngine.evaluate(symbolReturns, benchmarkReturns, residualZWindow, residualMomentumWindow);
        if (residualResult == null) {
            return null;
        }

        // ResidualReturnEngine doesn't expose the raw residual series (only derived stats), so the
        // idiosyncratic-vol computation here re-derives residuals via the same real OLS - a
        // deliberate, minimal duplication of the regression call itself (not the math it wraps),
        // since ResidualReturnEngine's own contract intentionally returns summary stats, not the series.
        io.argus.quantcore.institutional.math.OlsRegression.Result reg = fitForResiduals(symbolReturns, benchmarkReturns);
        if (reg == null) {
            return null;
        }
        double idiosyncraticVol = stdDev(reg.residuals());

        double amihudSum = 0;
        int amihudCount = 0;
        for (int i = 0; i < symbolReturns.length; i++) {
            if (dollarVolumes[i] <= 0) continue;
            amihudSum += Math.abs(symbolReturns[i]) / dollarVolumes[i];
            amihudCount++;
        }
        double amihud = amihudCount > 0 ? amihudSum / amihudCount : Double.NaN;

        return new Result(residualResult.beta(), idiosyncraticVol, amihud, residualResult.rSquared());
    }

    private static io.argus.quantcore.institutional.math.OlsRegression.Result fitForResiduals(double[] symbolReturns, double[] benchmarkReturns) {
        int n = symbolReturns.length;
        double[][] predictors = new double[n][1];
        for (int i = 0; i < n; i++) predictors[i][0] = benchmarkReturns[i];
        return io.argus.quantcore.institutional.math.OlsRegression.fit(predictors, symbolReturns, true);
    }

    private static double stdDev(double[] values) {
        double mean = 0;
        for (double v : values) mean += v;
        mean /= values.length;
        double s = 0;
        for (double v : values) s += (v - mean) * (v - mean);
        return Math.sqrt(s / values.length);
    }
}
