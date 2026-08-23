package io.argus.quantcore.stats;

import java.util.Arrays;

/**
 * Ported byte-for-byte from src/server/quant/statistics.ts's correlation/covariance/beta/
 * skewness/kurtosis/autocorrelation functions.
 */
public final class Correlation {

    private static final double NEAR_ZERO = RollingStatistics.NEAR_ZERO;

    private Correlation() {
    }

    public static Double correlation(double[] seriesA, double[] seriesB, int minOverlap) {
        int n = Math.min(seriesA.length, seriesB.length);
        if (n < minOverlap) {
            return null;
        }
        double[] a = tail(seriesA, n);
        double[] b = tail(seriesB, n);
        double meanA = mean(a), meanB = mean(b);
        double cov = 0, varA = 0, varB = 0;
        for (int i = 0; i < n; i++) {
            double da = a[i] - meanA, db = b[i] - meanB;
            cov += da * db;
            varA += da * da;
            varB += db * db;
        }
        if (varA < NEAR_ZERO || varB < NEAR_ZERO) {
            return null;
        }
        return cov / Math.sqrt(varA * varB);
    }

    public static Double correlation(double[] seriesA, double[] seriesB) {
        return correlation(seriesA, seriesB, 20);
    }

    public static Double covariance(double[] seriesA, double[] seriesB, int minOverlap) {
        int n = Math.min(seriesA.length, seriesB.length);
        if (n < minOverlap) {
            return null;
        }
        double[] a = tail(seriesA, n);
        double[] b = tail(seriesB, n);
        double meanA = mean(a), meanB = mean(b);
        double cov = 0;
        for (int i = 0; i < n; i++) {
            cov += (a[i] - meanA) * (b[i] - meanB);
        }
        return cov / (n - 1);
    }

    public static Double beta(double[] assetReturns, double[] benchmarkReturns, int minOverlap) {
        int n = Math.min(assetReturns.length, benchmarkReturns.length);
        if (n < minOverlap) {
            return null;
        }
        double[] a = tail(assetReturns, n);
        double[] b = tail(benchmarkReturns, n);
        double meanA = mean(a), meanB = mean(b);
        double sumCov = 0, sumVarB = 0;
        for (int i = 0; i < n; i++) {
            double da = a[i] - meanA, db = b[i] - meanB;
            sumCov += da * db;
            sumVarB += db * db;
        }
        if (sumVarB < NEAR_ZERO) {
            return null;
        }
        return sumCov / sumVarB;
    }

    public static Double skewness(double[] values, int minSamples) {
        int n = values.length;
        if (n < minSamples) {
            return null;
        }
        double mean = mean(values);
        double stdDev = Math.sqrt(sumPow(values, mean, 2) / n);
        if (stdDev < NEAR_ZERO) {
            return null;
        }
        double m3 = sumPow(values, mean, 3) / n;
        return m3 / Math.pow(stdDev, 3);
    }

    public static Double kurtosis(double[] values, int minSamples) {
        int n = values.length;
        if (n < minSamples) {
            return null;
        }
        double mean = mean(values);
        double stdDev = Math.sqrt(sumPow(values, mean, 2) / n);
        if (stdDev < NEAR_ZERO) {
            return null;
        }
        double m4 = sumPow(values, mean, 4) / n;
        return (m4 / Math.pow(stdDev, 4)) - 3;
    }

    public static Double autocorrelation(double[] values, int lag, int minOverlap) {
        if (lag < 1 || values.length - lag < minOverlap) {
            return null;
        }
        double[] a = Arrays.copyOfRange(values, 0, values.length - lag);
        double[] b = Arrays.copyOfRange(values, lag, values.length);
        return correlation(a, b, minOverlap);
    }

    private static double[] tail(double[] values, int n) {
        return Arrays.copyOfRange(values, values.length - n, values.length);
    }

    private static double mean(double[] values) {
        double s = 0;
        for (double v : values) {
            s += v;
        }
        return s / values.length;
    }

    private static double sumPow(double[] values, double mean, int power) {
        double s = 0;
        for (double v : values) {
            s += Math.pow(v - mean, power);
        }
        return s;
    }
}
