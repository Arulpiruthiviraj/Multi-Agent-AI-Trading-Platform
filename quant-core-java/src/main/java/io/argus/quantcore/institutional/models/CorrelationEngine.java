package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.EwmaCovariance;

/**
 * Pairwise/matrix correlation over a symbol universe, built on the already-real (previously
 * uncalled anywhere) EwmaCovariance.covarianceMatrix(). Correlation = cov[i][j] / sqrt(cov[i][i]*cov[j][j]),
 * clamped to [-1,1] to absorb floating-point drift at the boundary - never a fabricated value when
 * a variance is ~0 (returns null for that pair instead of dividing by zero).
 */
public final class CorrelationEngine {

    public record CorrelationResult(
        String[] symbols,
        double[][] correlationMatrix,
        double lambda
    ) {
    }

    private CorrelationEngine() {
    }

    /**
     * @param symbols        labels, same order/length as returnsByAsset.
     * @param returnsByAsset returnsByAsset[assetIndex][timeIndex] - all assets must share the same
     *                       length (same trading-day alignment).
     * @return null on ragged/insufficient input (mirrors EwmaCovariance's own null contract).
     */
    public static CorrelationResult compute(String[] symbols, double[][] returnsByAsset, double lambda) {
        if (symbols.length != returnsByAsset.length) return null;
        double[][] cov = EwmaCovariance.covarianceMatrix(returnsByAsset, lambda);
        if (cov == null) return null;

        int n = cov.length;
        double[][] corr = new double[n][n];
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                double denom = Math.sqrt(cov[i][i] * cov[j][j]);
                if (denom < 1e-15) {
                    corr[i][j] = i == j ? 1.0 : 0.0;
                    continue;
                }
                double r = cov[i][j] / denom;
                corr[i][j] = Math.max(-1.0, Math.min(1.0, r));
            }
        }
        return new CorrelationResult(symbols, corr, lambda);
    }

    public static CorrelationResult compute(String[] symbols, double[][] returnsByAsset) {
        return compute(symbols, returnsByAsset, EwmaCovariance.DEFAULT_LAMBDA);
    }
}
