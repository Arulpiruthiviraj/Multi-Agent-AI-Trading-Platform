package io.argus.quantcore.features;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Ported byte-for-byte from src/server/quant/statistics.ts - only the functions JMIG-001's
 * volatility.ts/MarketContext.ts ports actually call: rollingMean, rollingStdDev, zScore,
 * percentileRank, rollingReturns, rollingVolatility, correlation, beta. statistics.ts also exports
 * covariance/skewness/kurtosis/autocorrelation - real functions, but nothing in JMIG-001's file
 * scope (RegimeEngine/MarketContext/trend/volatility/priceAction/volume/supportResistance) calls
 * them, so they are not ported here (avoiding scope creep past what this migration item needs).
 */
public final class StatisticsMath {
    private StatisticsMath() {
    }

    // Same epsilon and same rationale as statistics.ts's own NEAR_ZERO: repeated/near-identical
    // floating point values never sum to exactly 0, so "is this variance/stddev effectively zero"
    // checks compare against this instead of `== 0`.
    private static final double NEAR_ZERO = 1e-10;

    public static Double rollingMean(double[] values, int period) {
        if (values.length < period || period < 1) {
            return null;
        }
        double sum = 0;
        for (int i = values.length - period; i < values.length; i++) {
            sum += values[i];
        }
        return sum / period;
    }

    public static Double rollingStdDev(double[] values, int period) {
        if (values.length < period || period < 1) {
            return null;
        }
        double mean = rollingMean(values, period);
        double variance = 0;
        for (int i = values.length - period; i < values.length; i++) {
            double d = values[i] - mean;
            variance += d * d;
        }
        variance /= period;
        return Math.sqrt(variance);
    }

    public static Double zScore(double[] values, int period) {
        if (values.length == 0) {
            return null;
        }
        Double mean = rollingMean(values, period);
        Double stdDev = rollingStdDev(values, period);
        if (mean == null || stdDev == null || stdDev < NEAR_ZERO) {
            return null;
        }
        return (values[values.length - 1] - mean) / stdDev;
    }

    public static Double percentileRank(double[] values, double currentValue) {
        if (values.length == 0) {
            return null;
        }
        int below = 0;
        for (double v : values) {
            if (v < currentValue) {
                below++;
            }
        }
        return (below / (double) values.length) * 100;
    }

    public static double[] rollingReturns(double[] values, int period) {
        List<Double> out = new ArrayList<>();
        for (int i = period; i < values.length; i++) {
            double prev = values[i - period];
            if (prev == 0) {
                continue;
            }
            out.add((values[i] - prev) / prev);
        }
        return toArray(out);
    }

    public static double[] rollingReturns(double[] values) {
        return rollingReturns(values, 1);
    }

    public static Double rollingVolatility(double[] values, int period) {
        double[] returns = rollingReturns(values, 1);
        return rollingStdDev(returns, period);
    }

    public static Double correlation(double[] seriesA, double[] seriesB, int minOverlap) {
        int n = Math.min(seriesA.length, seriesB.length);
        if (n < minOverlap) {
            return null;
        }
        double[] a = tail(seriesA, n);
        double[] b = tail(seriesB, n);
        double meanA = mean(a);
        double meanB = mean(b);
        double cov = 0;
        double varA = 0;
        double varB = 0;
        for (int i = 0; i < n; i++) {
            double da = a[i] - meanA;
            double db = b[i] - meanB;
            cov += da * db;
            varA += da * da;
            varB += db * db;
        }
        if (varA < NEAR_ZERO || varB < NEAR_ZERO) {
            return null;
        }
        return cov / Math.sqrt(varA * varB);
    }

    public static Double beta(double[] assetReturns, double[] benchmarkReturns, int minOverlap) {
        int n = Math.min(assetReturns.length, benchmarkReturns.length);
        if (n < minOverlap) {
            return null;
        }
        double[] a = tail(assetReturns, n);
        double[] b = tail(benchmarkReturns, n);
        double meanA = mean(a);
        double meanB = mean(b);
        double sumCov = 0;
        double sumVarB = 0;
        for (int i = 0; i < n; i++) {
            double da = a[i] - meanA;
            double db = b[i] - meanB;
            sumCov += da * db;
            sumVarB += db * db;
        }
        if (sumVarB < NEAR_ZERO) {
            return null;
        }
        return sumCov / sumVarB;
    }

    private static double[] tail(double[] arr, int n) {
        return Arrays.copyOfRange(arr, arr.length - n, arr.length);
    }

    private static double mean(double[] arr) {
        double s = 0;
        for (double v : arr) {
            s += v;
        }
        return s / arr.length;
    }

    private static double[] toArray(List<Double> list) {
        double[] arr = new double[list.size()];
        for (int i = 0; i < arr.length; i++) {
            arr[i] = list.get(i);
        }
        return arr;
    }
}
