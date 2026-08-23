package io.argus.quantcore.stats;

import java.util.Arrays;

/**
 * Ported byte-for-byte from src/server/quant/statistics.ts. Every method returns {@code null}
 * (never 0, never a guess) when there isn't enough real data — same contract as the TS source,
 * so callers distinguish "computed and zero" from "not computable yet."
 */
public final class RollingStatistics {

    /** Matches statistics.ts's NEAR_ZERO epsilon exactly. */
    static final double NEAR_ZERO = 1e-10;

    private RollingStatistics() {
    }

    public static Double rollingMean(double[] values, int period) {
        if (values.length < period || period < 1) {
            return null;
        }
        double[] slice = tail(values, period);
        return sum(slice) / period;
    }

    public static Double rollingStdDev(double[] values, int period) {
        if (values.length < period || period < 1) {
            return null;
        }
        double[] slice = tail(values, period);
        double mean = sum(slice) / period;
        double variance = 0;
        for (double v : slice) {
            variance += Math.pow(v - mean, 2);
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
        long below = Arrays.stream(values).filter(v -> v < currentValue).count();
        return (below / (double) values.length) * 100;
    }

    public static double[] rollingReturns(double[] values, int period) {
        double[] out = new double[Math.max(0, values.length - period)];
        int idx = 0;
        for (int i = period; i < values.length; i++) {
            double prev = values[i - period];
            if (prev == 0) {
                continue; // undefined return - skip, matching the TS `continue`
            }
            out[idx++] = (values[i] - prev) / prev;
        }
        return Arrays.copyOf(out, idx);
    }

    public static double[] rollingReturns(double[] values) {
        return rollingReturns(values, 1);
    }

    public static Double rollingVolatility(double[] values, int period) {
        return rollingStdDev(rollingReturns(values), period);
    }

    private static double[] tail(double[] values, int n) {
        return Arrays.copyOfRange(values, values.length - n, values.length);
    }

    private static double sum(double[] values) {
        double s = 0;
        for (double v : values) {
            s += v;
        }
        return s;
    }
}
