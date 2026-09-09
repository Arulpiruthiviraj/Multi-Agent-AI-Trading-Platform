package io.argus.quantcore.institutional.models;

/**
 * Average implied correlation from index and component implied volatilities - the same identity
 * behind the CBOE's published implied correlation indices, and the mechanism behind dispersion
 * trading (long component-option volatility / short index-option volatility, or vice versa, to
 * express a view on correlation rather than volatility itself). From portfolio-variance algebra:
 * sigma_I^2 = sum(w_i^2 sigma_i^2) + 2*sum_{i&lt;j}(w_i w_j rho_ij sigma_i sigma_j). Under the
 * simplifying assumption of a single average pairwise correlation rho_avg for every pair (the
 * same assumption CBOE's own methodology uses), the cross term collapses via
 * (sum w_i sigma_i)^2 = sum(w_i^2 sigma_i^2) + 2*sum_{i&lt;j}(w_i w_j sigma_i sigma_j), giving the
 * closed form solved here: rho_avg = (sigma_I^2 - sum(w_i^2 sigma_i^2)) / ((sum w_i sigma_i)^2 -
 * sum(w_i^2 sigma_i^2)).
 */
public final class ImpliedCorrelationEngine {

    private ImpliedCorrelationEngine() {
    }

    public record ComponentVolatility(double weight, double impliedVolatility) {
    }

    /**
     * @param indexImpliedVolatility the index option's own implied volatility.
     * @param components             each constituent's portfolio weight and implied volatility;
     *                                weights need not already sum to 1 (this class does not
     *                                normalize them - callers must supply real weights).
     * @return null if fewer than 2 components are supplied, or the denominator is degenerate
     *         (e.g. a single-name-dominated index where the identity breaks down), which is a
     *         genuinely undefined average correlation, not fabricated as 0 or 1.
     */
    public static Double evaluate(double indexImpliedVolatility, ComponentVolatility[] components) {
        if (components == null || components.length < 2) {
            return null;
        }
        double sumWeightedVol = 0;
        double sumSquaredWeightedVol = 0;
        for (ComponentVolatility c : components) {
            sumWeightedVol += c.weight() * c.impliedVolatility();
            sumSquaredWeightedVol += c.weight() * c.weight() * c.impliedVolatility() * c.impliedVolatility();
        }
        double denominator = sumWeightedVol * sumWeightedVol - sumSquaredWeightedVol;
        if (denominator == 0) {
            return null;
        }
        double numerator = indexImpliedVolatility * indexImpliedVolatility - sumSquaredWeightedVol;
        return numerator / denominator;
    }
}
