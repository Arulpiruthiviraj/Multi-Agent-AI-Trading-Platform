package io.argus.quantcore.features;

import io.argus.quantcore.backtest.engine.Bar;

import java.util.ArrayList;
import java.util.List;

/**
 * Ported byte-for-byte from src/server/quant/RegimeEngine.ts's classifyRegime (JMIG-001).
 *
 * {@code classifyDeskSession} is deliberately NOT ported: it is wall-clock ({@code new Date()})
 * dependent, not a pure function of the supplied bars, is not part of StrategyContext/RegimeResult's
 * core decision fields, and JMIG-001's own OUTPUT CONTRACT (docs/audits/
 * JAVA_MIGRATION_COMPLETION_PLAN_SUPPLEMENT.md) is the StrategyContext feature bundle, which does
 * not include it either.
 *
 * The TS {@code features: { trend, volatility, priceAction }} nesting is flattened onto this
 * class's {@link Result} record directly (fields {@code trend}/{@code volatilityFeatures}/
 * {@code priceAction}) rather than replicated as a further nested record - a structural
 * simplification, not a behavioral one. The top-level volatility LABEL ({@code "HIGH"/"LOW"/
 * "NORMAL"}) is {@link Result#volatility()}; the full computed volatility feature bundle is
 * {@link Result#volatilityFeatures()} - Java records cannot have two components of the same name,
 * so they are disambiguated this way (TS disambiguates them by nesting instead).
 */
public final class RegimeEngine {
    private RegimeEngine() {
    }

    public record Result(String regime, double trendStrength, String volatility, String marketStructure,
                          double confidence, TrendFeatures.Result trend, VolatilityFeatures.Result volatilityFeatures,
                          PriceActionFeatures.Result priceAction, boolean insufficientData) {
    }

    private static Boolean priceVsMaVote(TrendFeatures.PriceVsMA pvma) {
        if (pvma == null) {
            return null;
        }
        return Math.abs(pvma.diffPct()) > FeatureThresholds.MIN_MEANINGFUL_PRICE_VS_MA_PCT ? pvma.above() : null;
    }

    /** Each entry is true (bullish), false (bearish), or null (not computable yet, or real but too
     *  small/weak to treat as meaningful directional evidence) - matches RegimeEngine.ts's
     *  collectDirectionalVotes exactly, including its dead-zone thresholds. */
    private static List<Boolean> collectDirectionalVotes(TrendFeatures.Result trend) {
        List<Boolean> votes = new ArrayList<>();

        if (!"SIDEWAYS".equals(trend.structure().trend())) {
            votes.add("UPTREND".equals(trend.structure().trend()));
        } else {
            votes.add(null);
        }

        if (trend.dmi() != null && trend.dmi().adx() >= FeatureThresholds.MIN_MEANINGFUL_ADX) {
            votes.add(trend.dmi().plusDI() > trend.dmi().minusDI());
        } else {
            votes.add(null);
        }

        votes.add(priceVsMaVote(trend.priceVsSMA50()));
        votes.add(priceVsMaVote(trend.priceVsSMA200()));

        votes.add(trend.sma50SlopePct() != null && Math.abs(trend.sma50SlopePct()) > FeatureThresholds.MIN_MEANINGFUL_SLOPE_PCT
            ? trend.sma50SlopePct() > 0 : null);

        return votes;
    }

    private static String classifyVolatilityLabel(VolatilityFeatures.Result volatility) {
        if (volatility.volatilityPercentile() == null) {
            return "NORMAL";
        }
        if (volatility.volatilityPercentile() >= FeatureThresholds.VOLATILITY_PERCENTILE_HIGH) {
            return "HIGH";
        }
        if (volatility.volatilityPercentile() <= FeatureThresholds.VOLATILITY_PERCENTILE_LOW) {
            return "LOW";
        }
        return "NORMAL";
    }

    /** RANGING requires both a real low ADX AND real price-action consolidation; anything in
     *  between is honestly CHOPPY rather than forced into one of the other two. */
    private static String classifyMarketStructure(TrendFeatures.Result trend, PriceActionFeatures.Result priceAction) {
        Double adx = trend.dmi() != null ? trend.dmi().adx() : null;
        if (adx != null && adx >= FeatureThresholds.MIN_ADX_TRENDING) {
            return "TRENDING";
        }
        if (adx != null && adx < FeatureThresholds.MIN_ADX_RANGING && priceAction.consolidating()) {
            return "RANGING";
        }
        return "CHOPPY";
    }

    public static Result classifyRegime(List<Bar> bars) {
        TrendFeatures.Result trend = TrendFeatures.computeTrendFeatures(bars);
        VolatilityFeatures.Result volatility = VolatilityFeatures.computeVolatilityFeatures(bars);
        PriceActionFeatures.Result priceAction = PriceActionFeatures.computePriceActionFeatures(bars);

        List<Boolean> votes = collectDirectionalVotes(trend);
        List<Boolean> realVotes = votes.stream().filter(v -> v != null).toList();
        long bullishCount = realVotes.stream().filter(v -> v).count();

        final int minRealVotes = 2;
        String regime = "SIDEWAYS_RANGE";
        double agreementRatio = 0;
        if (realVotes.size() >= minRealVotes) {
            double bullishRatio = (double) bullishCount / realVotes.size();
            if (bullishRatio >= 0.6) {
                regime = "BULLISH_TREND";
                agreementRatio = bullishRatio;
            } else if (bullishRatio <= 0.4) {
                regime = "BEARISH_TREND";
                agreementRatio = 1 - bullishRatio;
            } else {
                regime = "SIDEWAYS_RANGE";
                agreementRatio = 1 - Math.abs(bullishRatio - 0.5) * 2;
            }
        }

        double completeness = (double) realVotes.size() / votes.size();
        double confidence = Math.round(agreementRatio * completeness * 100) / 100.0;

        double adx = trend.dmi() != null ? trend.dmi().adx() : 0;
        double trendStrength = Math.round(Math.min(100, Math.max(0, adx * (0.5 + agreementRatio * 0.5))));

        String volLabel = classifyVolatilityLabel(volatility);
        String structure = classifyMarketStructure(trend, priceAction);

        return new Result(regime, trendStrength, volLabel, structure, confidence, trend, volatility, priceAction,
            bars.size() < FeatureThresholds.REGIME_MIN_BARS);
    }
}
