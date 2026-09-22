package io.argus.quantcore.institutional.models;

import java.util.Arrays;

/**
 * ARGUS Crypto V2 (2026-09-21) - canonical log-return and log-return-volatility primitives.
 * Added specifically because the Tan (2025) BTC baseline methodology requires
 * ln(P_t/P_{t-1}) log returns, which no existing indicator in this codebase computes -
 * io.argus.quantcore.features.StatisticsMath.rollingReturns() is a SIMPLE return
 * ((P_t-P_{t-1})/P_{t-1}), a genuinely different formula, not a duplicate of this one (see that
 * class's own header: ported byte-for-byte from statistics.ts, which never included log returns).
 * This is the single authoritative home for log-return math going forward (CLAUDE.md Java rule 7).
 */
public final class CryptoLogReturns {
    private CryptoLogReturns() {
    }

    public static double logReturn(double priceT, double priceTMinus1) {
        if (priceTMinus1 <= 0 || priceT <= 0) {
            return Double.NaN;
        }
        return Math.log(priceT / priceTMinus1);
    }

    /** Full trailing series of 1-bar log returns; length = closes.length - 1. */
    public static double[] logReturnsSeries(double[] closes) {
        if (closes.length < 2) {
            return new double[0];
        }
        double[] out = new double[closes.length - 1];
        for (int i = 1; i < closes.length; i++) {
            out[i - 1] = logReturn(closes[i], closes[i - 1]);
        }
        return out;
    }

    /** N-bar cumulative log return ending at the last close: ln(close[last] / close[last-n]) -
     *  the Tan (2025) baseline's "30-day rolling momentum" computation. */
    public static Double cumulativeLogReturn(double[] closes, int lookbackBars) {
        int n = closes.length;
        if (n <= lookbackBars || lookbackBars < 1) {
            return null;
        }
        double prev = closes[n - 1 - lookbackBars];
        double last = closes[n - 1];
        if (prev <= 0 || last <= 0) {
            return null;
        }
        return Math.log(last / prev);
    }

    private static double annualizedStdDev(double[] returnsWindow, int periodsPerYear) {
        int period = returnsWindow.length;
        double mean = 0;
        for (double r : returnsWindow) {
            mean += r;
        }
        mean /= period;
        double sumSq = 0;
        for (double r : returnsWindow) {
            sumSq += (r - mean) * (r - mean);
        }
        return Math.sqrt(sumSq / period) * Math.sqrt(periodsPerYear);
    }

    /** Population-stdev annualized volatility of the trailing `period` log returns - the Tan
     *  (2025) baseline's "60-day annualized volatility". */
    public static Double annualizedVolatilityOfLogReturns(double[] closes, int period, int periodsPerYear) {
        double[] allReturns = logReturnsSeries(closes);
        if (allReturns.length < period) {
            return null;
        }
        double[] window = Arrays.copyOfRange(allReturns, allReturns.length - period, allReturns.length);
        return annualizedStdDev(window, periodsPerYear);
    }

    /**
     * One annualized-volatility reading per bar once enough history exists - the distribution
     * StatisticsMath.percentileRank() needs to rank the CURRENT reading against its own history
     * (the Tan baseline's "historical 80th percentile" comparison). O(n*period), computed once
     * from the shared log-return series rather than recomputing it per window.
     */
    public static double[] rollingAnnualizedVolatilitySeries(double[] closes, int period, int periodsPerYear) {
        double[] allReturns = logReturnsSeries(closes);
        if (allReturns.length < period) {
            return new double[0];
        }
        double[] out = new double[allReturns.length - period + 1];
        for (int end = period; end <= allReturns.length; end++) {
            double[] window = Arrays.copyOfRange(allReturns, end - period, end);
            out[end - period] = annualizedStdDev(window, periodsPerYear);
        }
        return out;
    }
}
