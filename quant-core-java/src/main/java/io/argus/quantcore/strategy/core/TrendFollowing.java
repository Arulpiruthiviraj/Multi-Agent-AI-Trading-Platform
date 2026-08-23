package io.argus.quantcore.strategy.core;

import io.argus.quantcore.strategy.types.*;

import java.util.ArrayList;
import java.util.List;

/** Ported byte-for-byte from src/server/quant/strategies/trendFollowing.ts. */
public final class TrendFollowing {
    public static final String ID = "TREND_FOLLOWING";
    public static final List<String> APPLICABLE_REGIMES = List.of("BULLISH_TREND", "BEARISH_TREND");

    public StrategyEvaluation evaluate(StrategyContext ctx) {
        var trend = ctx.trend();
        var momentum = ctx.momentum();
        var volume = ctx.volume();
        var regime = ctx.regime();
        boolean bullish = !"BEARISH_TREND".equals(regime.regime());
        StrategyEvaluation.Side side = bullish ? StrategyEvaluation.Side.BUY : StrategyEvaluation.Side.SELL;
        var ma = trend.movingAverages();

        List<String> conditionsMet = new ArrayList<>();
        List<String> conditionsFailed = new ArrayList<>();
        List<String> contradictions = new ArrayList<>();

        check(conditionsMet, conditionsFailed,
            bullish
                ? ("Strong BULLISH_TREND regime (trendStrength >= " + (int) QuantThresholds.MIN_TREND_STRENGTH + ")")
                : ("Strong BEARISH_TREND regime (trendStrength >= " + (int) QuantThresholds.MIN_TREND_STRENGTH + ")"),
            (bullish ? "BULLISH_TREND".equals(regime.regime()) : "BEARISH_TREND".equals(regime.regime()))
                && regime.trendStrength() >= QuantThresholds.MIN_TREND_STRENGTH);

        check(conditionsMet, conditionsFailed, "Market structure real TRENDING (not ranging/choppy)", "TRENDING".equals(regime.marketStructure()));

        check(conditionsMet, conditionsFailed,
            bullish ? "Moving averages ordered bullishly (SMA20 > SMA50 > SMA200)" : "Moving averages ordered bearishly (SMA20 < SMA50 < SMA200)",
            ma.sma20() != null && ma.sma50() != null && ma.sma200() != null
                && (bullish ? ma.sma20() > ma.sma50() && ma.sma50() > ma.sma200() : ma.sma20() < ma.sma50() && ma.sma50() < ma.sma200()));

        check(conditionsMet, conditionsFailed,
            bullish ? "DMI +DI > -DI with real ADX trend strength" : "DMI -DI > +DI with real ADX trend strength",
            trend.dmi() != null && trend.dmi().adx() >= QuantThresholds.MIN_ADX_TRENDING
                && (bullish ? trend.dmi().plusDI() > trend.dmi().minusDI() : trend.dmi().minusDI() > trend.dmi().plusDI()));

        check(conditionsMet, conditionsFailed,
            bullish ? "MACD bullish (line above signal)" : "MACD bearish (line below signal)",
            bullish ? momentum.macd().macd() > momentum.macd().signal() : momentum.macd().macd() < momentum.macd().signal());

        check(conditionsMet, conditionsFailed,
            bullish ? "Chaikin Money Flow confirming accumulation (CMF > 0)" : "Chaikin Money Flow confirming distribution (CMF < 0)",
            volume.cmf() != null && (bullish ? volume.cmf() > 0 : volume.cmf() < 0));

        if (bullish && trend.priceVsSMA200() != null && !trend.priceVsSMA200().above()) {
            contradictions.add("Price is below SMA200 despite a bullish trend-following signal - the long-term trend disagrees with the short/medium-term read.");
        }
        if (!bullish && trend.priceVsSMA200() != null && trend.priceVsSMA200().above()) {
            contradictions.add("Price is above SMA200 despite a bearish trend-following signal - the long-term trend disagrees with the short/medium-term read.");
        }

        int total = conditionsMet.size() + conditionsFailed.size();
        int setupScore = ScoreFromConditions.compute(conditionsMet, total);

        Double trailStop = ma.sma50();

        LevelSuggestion stop = trailStop != null
            ? new LevelSuggestion(trailStop, "SMA50 as a trailing stop - designed to be moved with the trend, not a fixed level.")
            : LevelSuggestion.none("No real SMA50 available yet to derive a trailing stop.");

        LevelSuggestion target = LevelSuggestion.none(
            "Trend-following is intentionally open-ended - no fixed target; trail the stop (e.g. along SMA50) as the trend extends.");

        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            conditionsMet, conditionsFailed, contradictions,
            List.of(
                "ADX falls below 20 (real trend strength fading - market structure shifting toward RANGING/CHOPPY).",
                "A structural CHoCH event occurs against the " + (bullish ? "uptrend" : "downtrend") + "."
            ),
            stop, target, APPLICABLE_REGIMES);
    }

    private static void check(List<String> met, List<String> failed, String name, boolean condition) {
        (condition ? met : failed).add(name);
    }
}
