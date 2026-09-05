package io.argus.quantcore.institutional.models;

import io.argus.quantcore.backtest.engine.Bar;

/**
 * Standardized volatility assessment combining the two real, independent volatility measures
 * already in this codebase - GarchEngine's fitted conditional-variance model and a simple
 * realized (close-to-close) volatility - into one comparable output, per the "many independent
 * models, combined explicitly" pattern (docs/audits/ARGUS_JAVA_PYTHON_NODE_PERFORMANCE_BOUNDARY_AUDIT.md
 * and the institutional quant activation plan). Does not invent a third number - realizedVolPercentile
 * is a real percentile-rank of the current realized vol against its own trailing window, not a
 * fabricated "regime probability".
 */
public final class VolatilityEngine {

    public record VolatilityAssessment(
        String symbol,
        double realizedVolatility,
        Double garchForecastVolatility,
        Double garchAlpha,
        Double garchBeta,
        double realizedVolPercentile,
        boolean compressed,
        boolean expanded
    ) {
    }

    private static final double COMPRESSION_PERCENTILE = 0.10;
    private static final double EXPANSION_PERCENTILE = 0.90;

    private VolatilityEngine() {
    }

    /**
     * @param closes chronological closes, oldest first - at least 30 required for a GARCH fit to
     *               attach (see GarchEngine.fit()'s own floor); fewer than that still returns a
     *               real realized-vol-only assessment with the GARCH fields null, never fabricated.
     */
    public static VolatilityAssessment assess(String symbol, double[] closes, int realizedVolWindow) {
        double[] returns = simpleReturns(closes);
        double currentRealizedVol = rollingStdDev(returns, Math.min(realizedVolWindow, returns.length));

        double[] rollingVolSeries = rollingVolatilitySeries(returns, realizedVolWindow);
        double percentile = percentileRank(rollingVolSeries, currentRealizedVol);

        GarchEngine.Params garch = returns.length >= 30 ? GarchEngine.fit(returns) : null;
        Double forecastVol = null;
        if (garch != null) {
            double[] variancePath = GarchEngine.conditionalVariancePath(returns, garch);
            double lastVariance = variancePath[variancePath.length - 1];
            double lastReturn = returns[returns.length - 1];
            forecastVol = Math.sqrt(Math.max(GarchEngine.forecastVariance(garch, lastReturn, lastVariance, 1), 0));
        }

        return new VolatilityAssessment(
            symbol,
            currentRealizedVol,
            forecastVol,
            garch != null ? garch.alpha() : null,
            garch != null ? garch.beta() : null,
            percentile,
            percentile <= COMPRESSION_PERCENTILE,
            percentile >= EXPANSION_PERCENTILE
        );
    }

    public static VolatilityAssessment assess(Bar[] bars, int realizedVolWindow) {
        double[] closes = new double[bars.length];
        for (int i = 0; i < bars.length; i++) closes[i] = bars[i].close();
        return assess(null, closes, realizedVolWindow);
    }

    private static double[] simpleReturns(double[] closes) {
        double[] out = new double[Math.max(0, closes.length - 1)];
        for (int i = 1; i < closes.length; i++) {
            out[i - 1] = closes[i - 1] == 0 ? 0 : (closes[i] - closes[i - 1]) / closes[i - 1];
        }
        return out;
    }

    private static double rollingStdDev(double[] returns, int window) {
        if (returns.length == 0 || window <= 0) return 0;
        int start = Math.max(0, returns.length - window);
        double mean = 0;
        int n = returns.length - start;
        for (int i = start; i < returns.length; i++) mean += returns[i];
        mean /= n;
        double variance = 0;
        for (int i = start; i < returns.length; i++) variance += (returns[i] - mean) * (returns[i] - mean);
        variance /= n;
        return Math.sqrt(variance);
    }

    /** Trailing series of rolling stdev values, one per window-ending index - used only to rank the current value against its own history. */
    private static double[] rollingVolatilitySeries(double[] returns, int window) {
        if (returns.length < window) return new double[0];
        double[] out = new double[returns.length - window + 1];
        for (int i = window - 1; i < returns.length; i++) {
            double mean = 0;
            for (int j = i - window + 1; j <= i; j++) mean += returns[j];
            mean /= window;
            double variance = 0;
            for (int j = i - window + 1; j <= i; j++) variance += (returns[j] - mean) * (returns[j] - mean);
            variance /= window;
            out[i - window + 1] = Math.sqrt(variance);
        }
        return out;
    }

    private static double percentileRank(double[] series, double value) {
        if (series.length == 0) return 0.5; // neutral - not enough history to rank against, never fabricated as compressed/expanded
        int countBelow = 0;
        for (double v : series) if (v <= value) countBelow++;
        return (double) countBelow / series.length;
    }
}
