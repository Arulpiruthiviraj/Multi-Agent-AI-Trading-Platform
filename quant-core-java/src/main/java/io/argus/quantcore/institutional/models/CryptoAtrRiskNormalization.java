package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.Volatility;

/**
 * ARGUS Crypto V2 (2026-09-21) - RESEARCH_ADVISORY_ONLY. ATR-based stop-distance / risk-
 * normalized position sizing research. Distinct from RiskEngine gate 21's live stop assumption
 * (tradingSafety.json stopLossAssumptionPct, a fixed 5% - CLAUDE.md: "AGENTS.md-era ATR-based
 * sizing is not live RiskEngine"). This class is a research comparison point only, never a live
 * sizing input.
 */
public final class CryptoAtrRiskNormalization {
    private CryptoAtrRiskNormalization() {
    }

    public record Suggestion(double atr, double stopDistancePerUnit, double suggestedQuantity) {
    }

    /**
     * @param atrMultiplier how many ATRs away the stop sits (e.g. 2.0)
     * @param riskDollars   dollars the caller is willing to risk on this position
     */
    public static Suggestion suggest(double[] highs, double[] lows, double[] closes, int atrPeriod,
                                      double atrMultiplier, double riskDollars) {
        double atr = Volatility.atr(highs, lows, closes, atrPeriod);
        double stopDistance = atr * atrMultiplier;
        double suggestedQuantity = stopDistance > 0 ? riskDollars / stopDistance : 0;
        return new Suggestion(atr, stopDistance, suggestedQuantity);
    }
}
