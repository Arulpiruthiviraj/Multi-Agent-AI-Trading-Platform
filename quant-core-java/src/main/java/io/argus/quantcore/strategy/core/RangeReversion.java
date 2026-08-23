package io.argus.quantcore.strategy.core;

import io.argus.quantcore.strategy.types.*;

import java.util.ArrayList;
import java.util.List;

/** Ported byte-for-byte from src/server/quant/strategies/rangeReversion.ts. */
public final class RangeReversion {
    public static final String ID = "RANGE_REVERSION";
    public static final List<String> APPLICABLE_REGIMES = List.of("SIDEWAYS_RANGE");

    public StrategyEvaluation evaluate(StrategyContext ctx) {
        var trend = ctx.trend();
        var momentum = ctx.momentum();
        var volume = ctx.volume();
        var priceAction = ctx.priceAction();
        var supportResistance = ctx.supportResistance();
        var regime = ctx.regime();
        var nearestSupport = supportResistance.nearest().nearestSupport();
        var nearestResistance = supportResistance.nearest().nearestResistance();

        double supportDist = nearestSupport != null ? Math.abs(nearestSupport.pct()) : Double.POSITIVE_INFINITY;
        double resistanceDist = nearestResistance != null ? Math.abs(nearestResistance.pct()) : Double.POSITIVE_INFINITY;
        boolean bullish = supportDist <= resistanceDist;
        StrategyEvaluation.Side side = bullish ? StrategyEvaluation.Side.BUY : StrategyEvaluation.Side.SELL;
        var nearBoundary = bullish ? nearestSupport : nearestResistance;
        var farBoundary = bullish ? nearestResistance : nearestSupport;

        List<String> conditionsMet = new ArrayList<>();
        List<String> conditionsFailed = new ArrayList<>();
        List<String> contradictions = new ArrayList<>();

        check(conditionsMet, conditionsFailed,
            "Range regime confirmed (RANGING market structure + real consolidation)",
            "RANGING".equals(regime.marketStructure()) && priceAction.consolidating());

        check(conditionsMet, conditionsFailed,
            bullish ? "Price near the range support boundary" : "Price near the range resistance boundary",
            nearBoundary != null && Math.abs(nearBoundary.pct()) <= QuantThresholds.NEAR_BOUNDARY_PCT);

        check(conditionsMet, conditionsFailed,
            bullish ? "RSI showing weakness at the boundary (<=40)" : "RSI showing strength at the boundary (>=60)",
            bullish ? momentum.rsi() <= 40 : momentum.rsi() >= 60);

        check(conditionsMet, conditionsFailed, "No real volume spike (a genuine breakout would show one)", !Boolean.TRUE.equals(volume.isSpike()));

        check(conditionsMet, conditionsFailed,
            "No real structural break in the fade direction (range still holding)",
            bullish ? !"BOS_BEARISH".equals(trend.structure().event()) : !"BOS_BULLISH".equals(trend.structure().event()));

        if (nearBoundary == null) {
            contradictions.add("No real nearest support/resistance level exists yet - this strategy cannot honestly identify a boundary to fade.");
        }
        if (Boolean.TRUE.equals(volume.isSpike())) {
            contradictions.add("A real volume spike is present, which is itself evidence of a genuine breakout attempt rather than range-holding.");
        }

        int total = conditionsMet.size() + conditionsFailed.size();
        int setupScore = ScoreFromConditions.compute(conditionsMet, total);

        LevelSuggestion stop = nearBoundary != null
            ? new LevelSuggestion(nearBoundary.level(), "Just beyond the real " + (bullish ? "support" : "resistance") + " boundary being faded.")
            : LevelSuggestion.none("No real range boundary available yet to derive a stop.");

        LevelSuggestion target = farBoundary != null
            ? new LevelSuggestion(farBoundary.level(), "The opposite real range boundary - trading the width of the range.")
            : LevelSuggestion.none("No real opposite range boundary available yet to derive a target.");

        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            conditionsMet, conditionsFailed, contradictions,
            List.of(
                "A real close beyond the " + (bullish ? "support" : "resistance") + " boundary confirms the range is breaking, not holding.",
                "A real volume spike accompanies the break (genuine breakout, not a fade-worthy range test)."
            ),
            stop, target, APPLICABLE_REGIMES);
    }

    private static void check(List<String> met, List<String> failed, String name, boolean condition) {
        (condition ? met : failed).add(name);
    }
}
