package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.institutional.models.FactorAlphaEngine;
import io.argus.quantcore.strategy.types.LevelSuggestion;
import io.argus.quantcore.strategy.types.StrategyEvaluation;

import java.util.ArrayList;
import java.util.List;

/**
 * Single-symbol decision logic over FactorAlphaEngine's 5-factor composite Z-score (momentum,
 * mean-reversion, volume/liquidity, volatility, OHLC-derived order-flow proxy - see
 * FactorAlphaEngine's own header for what "order-flow" means here and what it explicitly is not).
 * Research/quant-core infrastructure only, not wired into the live spine (see
 * InstitutionalStatArbStrategy's header for why that's a deliberate, separate future phase).
 */
public final class MultiFactorMomentumStrategy {

    public static final String ID = "INSTITUTIONAL_MULTI_FACTOR_MOMENTUM";

    private static final double ENTRY_COMPOSITE_THRESHOLD = 0.5;
    private static final int MOMENTUM_DAYS = 20;
    private static final int SMA_WINDOW = 10;
    private static final int Z_SCORE_WINDOW = 60;

    public StrategyEvaluation evaluate(InstitutionalStrategyContext ctx) {
        List<String> conditionsMet = new ArrayList<>();
        List<String> conditionsFailed = new ArrayList<>();
        List<String> contradictions = new ArrayList<>();

        FactorAlphaEngine.FactorScores scores = FactorAlphaEngine.compute(
            ctx.primaryBars(), MOMENTUM_DAYS, SMA_WINDOW, Z_SCORE_WINDOW);

        if (scores == null) {
            conditionsFailed.add("Not enough bar history for the requested factor windows.");
            return new StrategyEvaluation(ID, StrategyEvaluation.Side.BUY, 0, 0.0,
                conditionsMet, conditionsFailed, contradictions,
                List.of(), LevelSuggestion.none("No signal."), LevelSuggestion.none("No signal."),
                List.of("ANY_REGIME"));
        }

        boolean bullish = scores.composite() >= 0;
        StrategyEvaluation.Side side = bullish ? StrategyEvaluation.Side.BUY : StrategyEvaluation.Side.SELL;

        check(conditionsMet, conditionsFailed,
            bullish ? "Momentum factor positive" : "Momentum factor negative",
            bullish ? scores.momentum() > 0 : scores.momentum() < 0);
        check(conditionsMet, conditionsFailed,
            bullish ? "Mean-reversion factor supportive (not overbought)" : "Mean-reversion factor supportive (not oversold)",
            bullish ? scores.meanReversion() > -1.0 : scores.meanReversion() < 1.0);
        check(conditionsMet, conditionsFailed,
            "Volume/liquidity factor confirms (not a dead, illiquid tape)",
            scores.volumeLiquidity() > -1.0);
        check(conditionsMet, conditionsFailed,
            "Volatility factor supportive (not an unstable, high-vol regime)",
            scores.volatility() > -1.0);
        check(conditionsMet, conditionsFailed,
            bullish ? "OHLC order-flow proxy leans toward closes near the bar high" : "OHLC order-flow proxy leans toward closes near the bar low",
            bullish ? scores.orderFlowProxy() > 0 : scores.orderFlowProxy() < 0);
        check(conditionsMet, conditionsFailed,
            "Composite score exceeds the +/-" + ENTRY_COMPOSITE_THRESHOLD + " entry threshold",
            Math.abs(scores.composite()) >= ENTRY_COMPOSITE_THRESHOLD);

        int total = conditionsMet.size() + conditionsFailed.size();
        int setupScore = Math.abs(scores.composite()) >= ENTRY_COMPOSITE_THRESHOLD
            ? (int) Math.round(((double) conditionsMet.size() / total) * 100)
            : 0;

        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            conditionsMet, conditionsFailed, contradictions,
            List.of(
                "Composite factor score flips sign on a subsequent re-evaluation.",
                "Momentum factor reverses direction while other factors stay unchanged (trend exhaustion)."
            ),
            LevelSuggestion.none("Factor-composite strategy - no single structural stop level."),
            LevelSuggestion.none("Factor-composite strategy - no single structural target level."),
            List.of("ANY_REGIME"));
    }

    private static void check(List<String> met, List<String> failed, String name, boolean condition) {
        (condition ? met : failed).add(name);
    }
}
