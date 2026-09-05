package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.models.HmmRegimeEngine.Regime;
import io.argus.quantcore.institutional.models.QuantEnsembleEngine.EnsembleResult;
import io.argus.quantcore.institutional.models.QuantEnsembleEngine.Side;

/**
 * Dynamic Regime & Volatility Multiplier Layer. Scales (never re-derives) an already
 * correlation-adjusted QuantEnsembleEngine.EnsembleResult using two Conditioning/Volatility
 * Modifier signals (see config/engineOwnership.json's outputType tagging) - HmmRegimeEngine's
 * regime label and GarchEngine/VolatilityEngine's realized volatility. This is a downstream
 * scaling/gating step over an already-computed directional result, not a second vote: neither
 * input here is a Directional Alpha Provider, and this class does not touch
 * QuantEnsembleEngine's own Grinold-Kahn N_eff math at all.
 *
 * Both multipliers are explicit, reviewed, DECLARED ASSUMPTIONS, not measured/backtested values -
 * the same honesty discipline QuantEnsembleEngine's own DEFAULT_SAME_FAMILY_CORRELATION already
 * uses. A future ModelPerformanceTracker (not yet built anywhere in this codebase) recording real
 * per-regime win rates is what would eventually justify replacing REGIME_SUITABILITY with
 * empirical numbers - do not present these constants as backtested.
 *
 * ADVISORY ONLY: never calls emitTradeIdea-equivalent logic, never touches
 * RiskEngine/OMS/BrokerManager (zero broker imports anywhere in quant-core-java, by design).
 */
public final class RegimeVolatilityOverlay {

    /** A conventional "normal" daily equity volatility reference (declared, not measured) used as the inverse-volatility-targeting anchor - the same standard technique institutional portfolios use to scale exposure by realized volatility. */
    public static final double TARGET_DAILY_VOLATILITY = 0.015;
    public static final double MIN_VOLATILITY_MULTIPLIER = 0.25;
    public static final double MAX_VOLATILITY_MULTIPLIER = 1.5;

    /** Below this adjusted confidence, the advisory is marked gated (not surfaced as meaningful) - still purely advisory, never a block on anything in Node's own RiskEngine. */
    public static final double MIN_ADJUSTED_CONFIDENCE_TO_SURFACE = 0.15;

    public record AdjustedAdvisory(
        Side rawSide,
        double rawAvgConfidence,
        double rawEffectiveIndependentCount,
        Regime regime,
        double regimeMultiplier,
        double currentVolatility,
        double volatilityMultiplier,
        double adjustedConfidence,
        boolean gated,
        String reasoning
    ) {
    }

    private RegimeVolatilityOverlay() {
    }

    public static AdjustedAdvisory apply(EnsembleResult ensemble, Regime regime, double currentVolatility) {
        double regimeMult = regimeSuitability(regime, ensemble.rawSide());
        double volMult = volatilityMultiplier(currentVolatility);
        double adjusted = ensemble.rawSide() == Side.NEUTRAL
            ? 0.0
            : clamp(ensemble.avgConfidenceOfAgreeing() * regimeMult * volMult, 0.0, 1.0);
        boolean gated = ensemble.rawSide() == Side.NEUTRAL || adjusted < MIN_ADJUSTED_CONFIDENCE_TO_SURFACE;

        String reasoning = String.format(java.util.Locale.ROOT,
            "ensemble=%s avgConf=%.3f Neff=%.2f regime=%s regimeMult=%.2f vol=%.4f volMult=%.2f -> adjusted=%.3f%s",
            ensemble.rawSide(), ensemble.avgConfidenceOfAgreeing(), ensemble.effectiveIndependentCount(),
            regime, regimeMult, currentVolatility, volMult, adjusted, gated ? " (GATED - below surfacing threshold)" : "");

        return new AdjustedAdvisory(
            ensemble.rawSide(), ensemble.avgConfidenceOfAgreeing(), ensemble.effectiveIndependentCount(),
            regime, regimeMult, currentVolatility, volMult, adjusted, gated, reasoning);
    }

    /**
     * regimeSuitability(regime, side) - how much to trust a directional ensemble result given the
     * current regime. BULL/BEAR_TRENDING favor the trend-aligned side and discount the
     * counter-trend side; MEAN_REVERTING and HIGH_VOL_CHAOS discount both sides (a trend-style
     * ensemble result is inherently less trustworthy when the market isn't trending, or when
     * volatility is chaotic enough that any directional call is noisier). Declared assumption -
     * see class header; do not present as measured.
     */
    static double regimeSuitability(Regime regime, Side side) {
        if (side == Side.NEUTRAL) return 0.0;
        return switch (regime) {
            case BULL_TRENDING -> side == Side.BUY ? 1.0 : 0.5;
            case BEAR_TRENDING -> side == Side.SELL ? 1.0 : 0.5;
            case MEAN_REVERTING -> 0.7;
            case HIGH_VOL_CHAOS -> 0.4;
        };
    }

    /** Standard inverse-volatility-targeting scalar (a real, established risk-scaling technique, not invented for this pass) - multiplier = target / max(current, epsilon), clamped so a very quiet or very chaotic market never produces an unbounded scale factor. */
    static double volatilityMultiplier(double currentVolatility) {
        double raw = TARGET_DAILY_VOLATILITY / Math.max(currentVolatility, 1e-6);
        return clamp(raw, MIN_VOLATILITY_MULTIPLIER, MAX_VOLATILITY_MULTIPLIER);
    }

    private static double clamp(double v, double min, double max) {
        return Math.max(min, Math.min(max, v));
    }
}
