package io.argus.quantcore.institutional.models;

/**
 * Index volatility targeting with a risk-free asset - Kakushadze &amp; Serur, "151 Trading
 * Strategies" (2018), Section 6.5. Periodically rebalances between a risky index and a riskless
 * asset to maintain a constant target volatility: allocation weight to the risky asset
 * w = sigma_target / sigma, capped at an optional max leverage.
 */
public final class IndexVolatilityTargetingEngine {

    private IndexVolatilityTargetingEngine() {
    }

    public record Result(
        double riskyAssetWeight,
        double riskFreeAssetWeight
    ) {
    }

    /**
     * @param targetVolatility  sigma*, the desired volatility level.
     * @param currentVolatility sigma, the risky asset's current (typically implied, per the
     *                          paper's own note) volatility estimate.
     * @param maxLeverage       optional cap on riskyAssetWeight; pass Double.POSITIVE_INFINITY for none.
     * @return null if currentVolatility is not positive.
     */
    public static Result evaluate(double targetVolatility, double currentVolatility, double maxLeverage) {
        if (currentVolatility <= 0) {
            return null;
        }
        double weight = Math.min(targetVolatility / currentVolatility, maxLeverage);
        return new Result(weight, 1 - weight);
    }
}
