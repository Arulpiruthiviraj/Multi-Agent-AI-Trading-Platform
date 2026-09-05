package io.argus.quantcore.institutional.models;

/**
 * Volatility targeting: scales a base position/exposure by (target volatility / current realized
 * volatility), the standard real vol-targeting rule used across systematic strategies - capped at
 * a caller-supplied maximum leverage multiple. ADVISORY/RESEARCH ONLY: this is a research-side
 * sizing SUGGESTION - it never calls PositionSizing.ts or places a real order; the protected
 * architecture's own sizing remains the sole authority for what actually gets traded.
 */
public final class VolatilityTargetingEngine {

    private VolatilityTargetingEngine() {
    }

    public record Result(double scalingFactor, double targetPositionSize) {
    }

    /**
     * @param baseSize            unscaled reference position size (shares, dollars, or contracts - caller's units).
     * @param currentVolatility   real, measured current volatility of the asset (e.g. realized vol, same horizon as targetVolatility).
     * @param targetVolatility    desired volatility for the scaled position.
     * @param maxScalingFactor    hard cap on leverage this rule may suggest (e.g. 3.0) - never uncapped.
     * @return null for non-positive volatilities/sizes (never divides by zero or fabricates a scale).
     */
    public static Result evaluate(double baseSize, double currentVolatility, double targetVolatility, double maxScalingFactor) {
        if (currentVolatility <= 0 || targetVolatility <= 0 || baseSize < 0 || maxScalingFactor <= 0) {
            return null;
        }
        double scale = Math.min(targetVolatility / currentVolatility, maxScalingFactor);
        return new Result(scale, baseSize * scale);
    }
}
