package io.argus.quantcore.strategy.core;

import io.argus.quantcore.strategy.types.*;

import java.util.ArrayList;
import java.util.List;

/**
 * Ported byte-for-byte (decision logic only — see StrategyContext's own header comment on scope)
 * from src/server/quant/strategies/momentumBreakout.ts.
 */
public final class MomentumBreakout {
    public static final String ID = "MOMENTUM_BREAKOUT";
    public static final List<String> APPLICABLE_REGIMES = List.of("BULLISH_TREND", "BEARISH_TREND");

    public StrategyEvaluation evaluate(StrategyContext ctx) {
        var trend = ctx.trend();
        var momentum = ctx.momentum();
        var volatility = ctx.volatility();
        var volume = ctx.volume();
        var priceAction = ctx.priceAction();
        var supportResistance = ctx.supportResistance();
        var regime = ctx.regime();
        var marketContext = ctx.marketContext();

        boolean bullBreak = "BOS_BULLISH".equals(trend.structure().event());
        boolean bearBreak = "BOS_BEARISH".equals(trend.structure().event());
        boolean bullish = !(bearBreak && !bullBreak);
        StrategyEvaluation.Side side = bullish ? StrategyEvaluation.Side.BUY : StrategyEvaluation.Side.SELL;

        List<String> conditionsMet = new ArrayList<>();
        List<String> conditionsFailed = new ArrayList<>();
        List<String> contradictions = new ArrayList<>();

        check(conditionsMet, conditionsFailed, "Structural break in trade direction (BOS)", bullish ? bullBreak : bearBreak);
        check(conditionsMet, conditionsFailed,
            "RVOL confirmation (>=" + QuantThresholds.RVOL_THRESHOLD + "x average volume)",
            volume.relativeVolume() != null && volume.relativeVolume() >= QuantThresholds.RVOL_THRESHOLD);
        check(conditionsMet, conditionsFailed, "ATR expansion (volatility regime EXPANDING)", "EXPANDING".equals(volatility.regime()));
        Double vwapDist = volume.vwap() != null ? volume.vwap().distancePct() : null;
        check(conditionsMet, conditionsFailed,
            bullish ? "Price above session VWAP" : "Price below session VWAP",
            vwapDist != null && (bullish ? vwapDist > 0 : vwapDist < 0));
        check(conditionsMet, conditionsFailed, "Favorable market regime",
            bullish ? "BULLISH_TREND".equals(regime.regime()) : "BEARISH_TREND".equals(regime.regime()));

        var sectorRegime = marketContext.sector() != null && marketContext.sector().trend() != null
            ? marketContext.sector().trend().regime() : null;
        check(conditionsMet, conditionsFailed, "Favorable sector regime",
            sectorRegime != null && (bullish ? "BULLISH_TREND".equals(sectorRegime.regime()) : "BEARISH_TREND".equals(sectorRegime.regime())));

        Double rsVsSpy = marketContext.relativeStrengthVsSPY() != null ? marketContext.relativeStrengthVsSPY().relativeStrengthPct() : null;
        check(conditionsMet, conditionsFailed,
            bullish ? "Positive relative strength vs SPY" : "Negative relative strength vs SPY",
            rsVsSpy != null && (bullish ? rsVsSpy > 0 : rsVsSpy < 0));

        check(conditionsMet, conditionsFailed,
            bullish ? "Positive momentum (ROC > 0)" : "Negative momentum (ROC < 0)",
            momentum.roc() != null && (bullish ? momentum.roc() > 0 : momentum.roc() < 0));

        if (bullish && momentum.rsi() >= 80) {
            contradictions.add("RSI already extremely overbought (>=80) on a fresh bullish breakout - elevated risk of immediate failure/exhaustion.");
        }
        if (!bullish && momentum.rsi() <= 20) {
            contradictions.add("RSI already extremely oversold (<=20) on a fresh bearish breakdown - elevated risk of immediate failure/exhaustion.");
        }
        if (bullish && "SHOOTING_STAR".equals(priceAction.candlestick())) {
            contradictions.add("Most recent candle is a SHOOTING_STAR despite a bullish breakout signal.");
        }
        if (!bullish && "HAMMER".equals(priceAction.candlestick())) {
            contradictions.add("Most recent candle is a HAMMER despite a bearish breakdown signal.");
        }

        int total = conditionsMet.size() + conditionsFailed.size();
        int setupScore = ScoreFromConditions.compute(conditionsMet, total);

        Double brokenLevel = bullish ? trend.structure().lastSwingHigh() : trend.structure().lastSwingLow();
        var nearestBeyond = bullish ? supportResistance.nearest().nearestResistance() : supportResistance.nearest().nearestSupport();
        double atr = volatility.atr();

        LevelSuggestion stop = brokenLevel != null && atr != 0
            ? new LevelSuggestion(bullish ? brokenLevel - atr : brokenLevel + atr,
                "1x ATR " + (bullish ? "below" : "above") + " the broken structural level (" + String.format("%.2f", brokenLevel) + ").")
            : LevelSuggestion.none("No real broken structural level or ATR available yet to derive a stop.");

        LevelSuggestion target = nearestBeyond != null
            ? new LevelSuggestion(nearestBeyond.level(), "Next real " + (bullish ? "resistance" : "support") + " level beyond the breakout.")
            : atr != 0
                ? new LevelSuggestion(ctx.currentPrice() + (bullish ? 2 * atr : -2 * atr), "2x ATR measured move (no further real S/R level available).")
                : LevelSuggestion.none("No further real level or ATR available yet to derive a target.");

        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            conditionsMet, conditionsFailed, contradictions,
            List.of(
                "Price closes back " + (bullish ? "below" : "above") + " the broken level (false breakout).",
                "RVOL drops back below 1.2x average on the follow-through bar(s).",
                "Market regime flips away from " + (bullish ? "BULLISH_TREND" : "BEARISH_TREND") + "."
            ),
            stop, target, APPLICABLE_REGIMES);
    }

    private static void check(List<String> met, List<String> failed, String name, boolean condition) {
        (condition ? met : failed).add(name);
    }
}
