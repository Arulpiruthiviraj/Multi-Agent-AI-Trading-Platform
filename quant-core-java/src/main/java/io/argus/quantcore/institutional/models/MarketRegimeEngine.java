package io.argus.quantcore.institutional.models;

/**
 * Combines the two real, independent regime signals this codebase actually has - HmmRegimeEngine's
 * 4-state Gaussian HMM classification and VolatilityEngine's compression/expansion percentile -
 * into one assessment. Deliberately does NOT claim a "correlation regime" or "dispersion regime"
 * (the institutional activation plan's wishlist) since no cross-asset correlation-regime
 * classifier exists in this codebase yet - reporting only what's real.
 */
public final class MarketRegimeEngine {

    public record RegimeAssessment(
        String symbol,
        HmmRegimeEngine.Regime hmmRegime,
        double hmmLogLikelihood,
        boolean volatilityCompressed,
        boolean volatilityExpanded,
        double volatilityPercentile
    ) {
    }

    private MarketRegimeEngine() {
    }

    /** @return null if the HMM couldn't fit (insufficient observations) - never a fabricated regime label. */
    public static RegimeAssessment assess(String symbol, HmmRegimeEngine.Observation[] hmmObservations, double[] closes, int volatilityWindow) {
        HmmRegimeEngine.Fitted fitted = HmmRegimeEngine.fit(hmmObservations, 100);
        if (fitted == null) return null;
        HmmRegimeEngine.Regime current = HmmRegimeEngine.currentRegime(fitted, hmmObservations);
        VolatilityEngine.VolatilityAssessment vol = VolatilityEngine.assess(symbol, closes, volatilityWindow);
        return new RegimeAssessment(symbol, current, fitted.logLikelihood(), vol.compressed(), vol.expanded(), vol.realizedVolPercentile());
    }
}
