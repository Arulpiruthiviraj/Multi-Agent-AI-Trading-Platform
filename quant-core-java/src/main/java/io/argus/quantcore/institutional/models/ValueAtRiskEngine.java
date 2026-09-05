package io.argus.quantcore.institutional.models;

import java.util.Arrays;

/**
 * Historical VaR/Expected-Shortfall (real empirical tail statistics, no distributional
 * assumption) plus parametric (Gaussian) VaR for comparison - both expressed as a positive loss
 * number. The parametric path uses Peter Acklam's rational approximation for the inverse normal
 * CDF (accurate to ~1.15e-9 relative error - a standard, real numerical method, not a lookup table
 * limited to a few conventional confidence levels).
 */
public final class ValueAtRiskEngine {

    private ValueAtRiskEngine() {
    }

    public record Result(double historicalVaR, double historicalExpectedShortfall, double parametricVaR) {
    }

    /**
     * @param returns         chronological simple returns (not necessarily sorted).
     * @param confidenceLevel e.g. 0.95 or 0.99.
     * @return null for degenerate inputs (empty series, confidence level outside (0,1)).
     */
    public static Result evaluate(double[] returns, double confidenceLevel) {
        int n = returns.length;
        if (n == 0 || confidenceLevel <= 0 || confidenceLevel >= 1) {
            return null;
        }
        double[] sorted = returns.clone();
        Arrays.sort(sorted);

        int idx = (int) Math.floor((1 - confidenceLevel) * n);
        idx = Math.max(0, Math.min(idx, n - 1));
        double historicalVaR = -sorted[idx];

        double esSum = 0;
        for (int i = 0; i <= idx; i++) esSum += sorted[i];
        double historicalEs = -(esSum / (idx + 1));

        double mean = 0;
        for (double v : returns) mean += v;
        mean /= n;
        double variance = 0;
        for (double v : returns) variance += (v - mean) * (v - mean);
        variance /= n;
        double stdDev = Math.sqrt(variance);

        double z = inverseNormalCdf(1 - confidenceLevel);
        double parametricVaR = -(mean + z * stdDev);

        return new Result(historicalVaR, historicalEs, parametricVaR);
    }

    /** Peter Acklam's rational approximation of the inverse standard normal CDF. */
    private static double inverseNormalCdf(double p) {
        if (p <= 0 || p >= 1) {
            return Double.NaN;
        }
        double[] a = {-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
            1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00};
        double[] b = {-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
            6.680131188771972e+01, -1.328068155288572e+01};
        double[] c = {-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
            -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00};
        double[] d = {7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
            3.754408661907416e+00};

        double pLow = 0.02425;
        double pHigh = 1 - pLow;

        if (p < pLow) {
            double q = Math.sqrt(-2 * Math.log(p));
            return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
                / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
        }
        if (p <= pHigh) {
            double q = p - 0.5;
            double r = q * q;
            return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
                / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
        }
        double q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
}
