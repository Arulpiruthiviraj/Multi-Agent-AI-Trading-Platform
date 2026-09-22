package io.argus.quantcore.institutional.models;

/**
 * ARGUS Crypto V2 (2026-09-21) - RESEARCH_ADVISORY_ONLY. A pure sizing SUGGESTION function,
 * matching the same disclosed pattern as the existing VolatilityTargetingEngine.java
 * (config/engineOwnership.json: "a sizing SUGGESTION only, never calls PositionSizing.ts or
 * places an order"). This class must NEVER be called from src/server/engines/PositionSizing.ts
 * or any live path - RiskEngine's own gate 21 (sufficient_size) and gate 16
 * (order_notional_cap) remain the sole live sizing authority (CLAUDE.md protected architecture).
 *
 * position size fraction = targetVolatility / forecastVolatility, capped at maxScaleFactor so a
 * very low forecast volatility can never blow the position size up unboundedly.
 */
public final class CryptoVolatilityScaledPositionSizing {
    private CryptoVolatilityScaledPositionSizing() {
    }

    public record Suggestion(double baseFraction, double scaledFraction, double scaleFactor, boolean capped) {
    }

    /**
     * @param baseFraction       the strategy/portfolio's normal position size as a fraction of capital (e.g. 0.05 = 5%)
     * @param targetVolatility   the annualized volatility the sizing model targets (e.g. 0.40 = 40%/yr)
     * @param forecastVolatility the current forecast/realized annualized volatility for this symbol
     * @param maxScaleFactor     hard cap on how much the base size may be scaled up (e.g. 2.0 = never more than 2x)
     */
    public static Suggestion suggest(double baseFraction, double targetVolatility, double forecastVolatility, double maxScaleFactor) {
        if (forecastVolatility <= 0 || targetVolatility <= 0 || baseFraction <= 0) {
            return new Suggestion(baseFraction, baseFraction, 1.0, false);
        }
        double rawScaleFactor = targetVolatility / forecastVolatility;
        boolean capped = rawScaleFactor > maxScaleFactor;
        double scaleFactor = capped ? maxScaleFactor : rawScaleFactor;
        return new Suggestion(baseFraction, baseFraction * scaleFactor, scaleFactor, capped);
    }
}
