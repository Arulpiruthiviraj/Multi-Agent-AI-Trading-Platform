package io.argus.quantcore.institutional.math;

/**
 * RiskMetrics-style exponentially weighted covariance: {@code Cov_t = lambda*Cov_{t-1} +
 * (1-lambda)*r_{t-1}*r'_{t-1}}. Recursion is seeded with the equal-weighted sample covariance of
 * the full series (a standard practical choice - an unseeded/zero start would bias the first
 * many periods toward zero) rather than pretending there's a "true" prior covariance before any
 * data existed.
 */
public final class EwmaCovariance {

    /** RiskMetrics' standard daily decay factor. */
    public static final double DEFAULT_LAMBDA = 0.94;

    private EwmaCovariance() {
    }

    /** Single-series EWMA variance (diagonal case). */
    public static Double variance(double[] returns, double lambda) {
        if (returns.length < 2) {
            return null;
        }
        double seed = sampleVariance(returns);
        double v = seed;
        for (int t = 1; t < returns.length; t++) {
            v = lambda * v + (1 - lambda) * returns[t - 1] * returns[t - 1];
        }
        return v;
    }

    /**
     * @param returnsByAsset returnsByAsset[assetIndex][timeIndex] - all assets must share the
     *                       same length (same trading-day alignment); ragged input is rejected.
     * @return the final N x N EWMA covariance matrix, or null on ragged/insufficient input.
     */
    public static double[][] covarianceMatrix(double[][] returnsByAsset, double lambda) {
        int m = returnsByAsset.length;
        if (m == 0) {
            return null;
        }
        int n = returnsByAsset[0].length;
        for (double[] series : returnsByAsset) {
            if (series.length != n) {
                return null;
            }
        }
        if (n < 2) {
            return null;
        }

        double[][] cov = new double[m][m];
        for (int i = 0; i < m; i++) {
            for (int j = i; j < m; j++) {
                double seed = sampleCovariance(returnsByAsset[i], returnsByAsset[j]);
                cov[i][j] = seed;
                cov[j][i] = seed;
            }
        }

        for (int t = 1; t < n; t++) {
            double[][] next = new double[m][m];
            for (int i = 0; i < m; i++) {
                for (int j = i; j < m; j++) {
                    double updated = lambda * cov[i][j] + (1 - lambda) * returnsByAsset[i][t - 1] * returnsByAsset[j][t - 1];
                    next[i][j] = updated;
                    next[j][i] = updated;
                }
            }
            cov = next;
        }
        return cov;
    }

    private static double sampleVariance(double[] values) {
        double mean = mean(values);
        double s = 0;
        for (double v : values) {
            s += (v - mean) * (v - mean);
        }
        return s / values.length;
    }

    private static double sampleCovariance(double[] a, double[] b) {
        double meanA = mean(a), meanB = mean(b);
        double s = 0;
        for (int i = 0; i < a.length; i++) {
            s += (a[i] - meanA) * (b[i] - meanB);
        }
        return s / a.length;
    }

    private static double mean(double[] values) {
        double s = 0;
        for (double v : values) s += v;
        return s / values.length;
    }
}
