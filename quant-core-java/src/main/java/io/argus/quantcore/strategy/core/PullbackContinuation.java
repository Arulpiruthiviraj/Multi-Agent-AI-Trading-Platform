package io.argus.quantcore.strategy.core;

import io.argus.quantcore.strategy.types.*;

import java.util.ArrayList;
import java.util.List;

/** Ported byte-for-byte from src/server/quant/strategies/pullbackContinuation.ts. */
public final class PullbackContinuation {
    public static final String ID = "PULLBACK_CONTINUATION";
    public static final List<String> APPLICABLE_REGIMES = List.of("BULLISH_TREND", "BEARISH_TREND");

    public StrategyEvaluation evaluate(StrategyContext ctx) {
        var trend = ctx.trend();
        var momentum = ctx.momentum();
        var volume = ctx.volume();
        var priceAction = ctx.priceAction();
        var supportResistance = ctx.supportResistance();
        var regime = ctx.regime();

        boolean bullish = "UPTREND".equals(trend.structure().trend())
            || (!"DOWNTREND".equals(trend.structure().trend()) && "BULLISH_TREND".equals(regime.regime()));
        StrategyEvaluation.Side side = bullish ? StrategyEvaluation.Side.BUY : StrategyEvaluation.Side.SELL;

        List<String> conditionsMet = new ArrayList<>();
        List<String> conditionsFailed = new ArrayList<>();
        List<String> contradictions = new ArrayList<>();

        check(conditionsMet, conditionsFailed,
            bullish ? "Established uptrend (market structure + regime)" : "Established downtrend (market structure + regime)",
            bullish
                ? "UPTREND".equals(trend.structure().trend()) && "BULLISH_TREND".equals(regime.regime())
                : "DOWNTREND".equals(trend.structure().trend()) && "BEARISH_TREND".equals(regime.regime()));

        var pvma20 = trend.priceVsSMA20();
        check(conditionsMet, conditionsFailed,
            "Price pulled back to/near SMA20 without breaking decisively through it",
            pvma20 != null
                && Math.abs(pvma20.diffPct()) <= QuantThresholds.PULLBACK_TOLERANCE_PCT
                && (bullish ? pvma20.diffPct() > -QuantThresholds.PULLBACK_TOLERANCE_PCT : pvma20.diffPct() < QuantThresholds.PULLBACK_TOLERANCE_PCT));

        check(conditionsMet, conditionsFailed, "RSI in a healthy (non-extreme) pullback zone",
            momentum.rsi() >= QuantThresholds.HEALTHY_RSI_MIN && momentum.rsi() <= QuantThresholds.HEALTHY_RSI_MAX);

        check(conditionsMet, conditionsFailed,
            bullish ? "Bullish reversal candlestick at the pullback low" : "Bearish reversal candlestick at the pullback high",
            bullish
                ? "HAMMER".equals(priceAction.candlestick()) || "BULLISH_ENGULFING".equals(priceAction.candlestick())
                : "SHOOTING_STAR".equals(priceAction.candlestick()) || "BEARISH_ENGULFING".equals(priceAction.candlestick()));

        check(conditionsMet, conditionsFailed,
            "Volume contracted during the pullback (below average - lack of opposing pressure)",
            volume.relativeVolume() != null && volume.relativeVolume() < 1);

        check(conditionsMet, conditionsFailed,
            "No structural reversal against the trend (no opposing CHoCH)",
            bullish ? !"CHOCH_BEARISH".equals(trend.structure().event()) : !"CHOCH_BULLISH".equals(trend.structure().event()));

        if (bullish && trend.dmi() != null && trend.dmi().minusDI() > trend.dmi().plusDI()) {
            contradictions.add("DMI shows -DI > +DI despite a bullish pullback setup - directional momentum has already flipped bearish.");
        }
        if (!bullish && trend.dmi() != null && trend.dmi().plusDI() > trend.dmi().minusDI()) {
            contradictions.add("DMI shows +DI > -DI despite a bearish pullback setup - directional momentum has already flipped bullish.");
        }

        int total = conditionsMet.size() + conditionsFailed.size();
        int setupScore = ScoreFromConditions.compute(conditionsMet, total);

        Double maValue = trend.movingAverages().sma20();
        Double structuralStop = bullish ? trend.structure().lastSwingLow() : trend.structure().lastSwingHigh();
        var target = bullish ? supportResistance.nearest().nearestResistance() : supportResistance.nearest().nearestSupport();

        LevelSuggestion stop = structuralStop != null
            ? new LevelSuggestion(structuralStop, "Most recent real swing " + (bullish ? "low" : "high") + " (" + String.format("%.2f", structuralStop) + ") that defines the pullback.")
            : maValue != null
                ? new LevelSuggestion(maValue, "SMA20 value (no real swing point available yet).")
                : LevelSuggestion.none("No real swing point or SMA20 available yet to derive a stop.");

        LevelSuggestion targetLevel = target != null
            ? new LevelSuggestion(target.level(), "Nearest real " + (bullish ? "resistance" : "support") + " level - the prior trend " + (bullish ? "high" : "low") + " being retested.")
            : LevelSuggestion.none("No further real level available yet to derive a target.");

        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            conditionsMet, conditionsFailed, contradictions,
            List.of(
                "Price closes decisively " + (bullish ? "below" : "above") + " SMA20 / the pullback low" + (bullish ? "" : " (high)") + ".",
                "Market structure flips to " + (bullish ? "CHOCH_BEARISH" : "CHOCH_BULLISH") + "."
            ),
            stop, targetLevel, APPLICABLE_REGIMES);
    }

    private static void check(List<String> met, List<String> failed, String name, boolean condition) {
        (condition ? met : failed).add(name);
    }
}
