package io.argus.quantcore.strategy.core;

import io.argus.quantcore.strategy.types.*;

import java.util.ArrayList;
import java.util.List;

/** Ported byte-for-byte from src/server/quant/strategies/meanReversion.ts. */
public final class MeanReversion {
    public static final String ID = "MEAN_REVERSION";
    public static final List<String> APPLICABLE_REGIMES = List.of("SIDEWAYS_RANGE");

    public StrategyEvaluation evaluate(StrategyContext ctx) {
        var momentum = ctx.momentum();
        var volatility = ctx.volatility();
        var priceAction = ctx.priceAction();
        var supportResistance = ctx.supportResistance();
        var regime = ctx.regime();
        double currentPrice = ctx.currentPrice();

        boolean oversold = momentum.rsi() <= QuantThresholds.RSI_OVERSOLD;
        boolean overbought = momentum.rsi() >= QuantThresholds.RSI_OVERBOUGHT;
        boolean bullish = !overbought;
        StrategyEvaluation.Side side = bullish ? StrategyEvaluation.Side.BUY : StrategyEvaluation.Side.SELL;

        List<String> conditionsMet = new ArrayList<>();
        List<String> conditionsFailed = new ArrayList<>();
        List<String> contradictions = new ArrayList<>();

        check(conditionsMet, conditionsFailed,
            "Ranging / non-trending regime (not a real directional trend)",
            "RANGING".equals(regime.marketStructure()) || "SIDEWAYS_RANGE".equals(regime.regime()));

        check(conditionsMet, conditionsFailed,
            bullish ? ("RSI oversold (<=" + (int) QuantThresholds.RSI_OVERSOLD + ")") : ("RSI overbought (>=" + (int) QuantThresholds.RSI_OVERBOUGHT + ")"),
            bullish ? oversold : overbought);

        var keltner = volatility.keltner();
        check(conditionsMet, conditionsFailed,
            bullish ? "Price at/below the lower Keltner Channel" : "Price at/above the upper Keltner Channel",
            keltner != null && (bullish ? currentPrice <= keltner.lower() : currentPrice >= keltner.upper()));

        check(conditionsMet, conditionsFailed,
            bullish ? "Stochastic RSI confirming oversold (<=20)" : "Stochastic RSI confirming overbought (>=80)",
            momentum.stochasticRSI() != null
                && (bullish ? momentum.stochasticRSI() <= QuantThresholds.STOCH_RSI_OVERSOLD : momentum.stochasticRSI() >= QuantThresholds.STOCH_RSI_OVERBOUGHT));

        check(conditionsMet, conditionsFailed,
            bullish ? "Bullish reversal candlestick" : "Bearish reversal candlestick",
            bullish
                ? "HAMMER".equals(priceAction.candlestick()) || "BULLISH_ENGULFING".equals(priceAction.candlestick())
                : "SHOOTING_STAR".equals(priceAction.candlestick()) || "BEARISH_ENGULFING".equals(priceAction.candlestick()));

        if (bullish && "BEARISH_TREND".equals(regime.regime())) {
            contradictions.add("Regime is BEARISH_TREND, not ranging - fading an oversold reading against a real downtrend is a materially riskier trade.");
        }
        if (!bullish && "BULLISH_TREND".equals(regime.regime())) {
            contradictions.add("Regime is BULLISH_TREND, not ranging - fading an overbought reading against a real uptrend is a materially riskier trade.");
        }

        int total = conditionsMet.size() + conditionsFailed.size();
        int setupScore = ScoreFromConditions.compute(conditionsMet, total);

        var structuralStop = bullish ? supportResistance.nearest().nearestSupport() : supportResistance.nearest().nearestResistance();
        Double meanTarget = keltner != null ? keltner.middle() : null;

        LevelSuggestion stop = structuralStop != null
            ? new LevelSuggestion(structuralStop.level(), "Nearest real " + (bullish ? "support" : "resistance") + " level - beyond it, the range is broken, not just reverting.")
            : LevelSuggestion.none("No real support/resistance level available yet to derive a stop.");

        LevelSuggestion target = meanTarget != null
            ? new LevelSuggestion(meanTarget, "Keltner Channel middle line (the statistical 'mean' being reverted to).")
            : LevelSuggestion.none("No real Keltner Channel available yet to derive a mean-reversion target.");

        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            conditionsMet, conditionsFailed, contradictions,
            List.of(
                "Price makes a real new " + (bullish ? "low" : "high") + " beyond the recent range (the range itself is breaking, not just reverting).",
                "Market structure trend flips to a real " + (bullish ? "DOWNTREND" : "UPTREND") + "."
            ),
            stop, target, APPLICABLE_REGIMES);
    }

    private static void check(List<String> met, List<String> failed, String name, boolean condition) {
        (condition ? met : failed).add(name);
    }
}
