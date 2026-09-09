package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.HodrickPrescottFilter;
import io.argus.quantcore.indicators.MovingAverages;

/**
 * HP-filtered moving-average crossover for FX - Kakushadze &amp; Serur, "151 Trading Strategies"
 * (2018), Section 8.1, citing Harris &amp; Yilmaz, "A Momentum Trading Strategy Based on the Low
 * Frequency Component of the Exchange Rate," 2009. FX spot rates are noisier than equity prices, so
 * before computing the two crossover moving averages, the series is first passed through the
 * Hodrick-Prescott filter (HodrickPrescottFilter.java) to isolate the low-frequency trend
 * component S*(t); MA(T1) and MA(T2), T1 &lt; T2, are then computed on S*(t) rather than the raw
 * spot rate. Same crossover rule as the equity/ETF two-MA strategies already in this codebase
 * (MA(T1) &gt; MA(T2) is a buy signal) - the HP pre-filter is the only thing distinct about this one.
 */
public final class FxHpFilteredMovingAverageEngine {

    private FxHpFilteredMovingAverageEngine() {
    }

    public record Result(
        double maFast,
        double maSlow,
        String signal // BUY (maFast > maSlow), SELL (maFast < maSlow), NEUTRAL
    ) {
    }

    /**
     * @param spotRates chronological FX spot rates (typically monthly, per the paper's own
     *                  convention for this strategy).
     * @param lambda    HP filter smoothing parameter (see HodrickPrescottFilter's own docs -
     *                  commonly 14400 for monthly data, not defaulted here).
     * @param fastPeriod, slowPeriod MA lengths computed on the filtered trend, fastPeriod &lt; slowPeriod.
     * @return null if the HP filter itself fails (too little history) or there isn't enough
     *         filtered history for the slower MA.
     */
    public static Result evaluate(double[] spotRates, double lambda, int fastPeriod, int slowPeriod) {
        if (spotRates == null || fastPeriod < 1 || slowPeriod <= fastPeriod || spotRates.length < slowPeriod) {
            return null;
        }
        double[] trend = HodrickPrescottFilter.trend(spotRates, lambda);
        if (trend == null || trend.length < slowPeriod) {
            return null;
        }
        double maFast = MovingAverages.sma(trend, fastPeriod);
        double maSlow = MovingAverages.sma(trend, slowPeriod);

        String signal = maFast > maSlow ? "BUY" : maFast < maSlow ? "SELL" : "NEUTRAL";
        return new Result(maFast, maSlow, signal);
    }

    /** Paper's own convention: monthly data (lambda = 14400). */
    public static Result evaluate(double[] spotRates, int fastPeriod, int slowPeriod) {
        return evaluate(spotRates, 14400.0, fastPeriod, slowPeriod);
    }
}
