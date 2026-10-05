package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.backtest.engine.Bar;
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
 *
 * DESIGN NOTE (2026-10-05): the trigger is composite-only — a vote can fire while the momentum
 * factor itself is deeply negative, if the other four factors carry the composite past the
 * entry threshold. This is intentional: the composite is the strategy's position, not any single
 * factor. The momentum-factor condition is still reported in conditionsMet/Failed for forensics.
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

        // DEFECT FIX (2026-10-05): null-guard ctx and validate bar hygiene BEFORE delegating to
        // FactorAlphaEngine, which performs no input validation. Siblings (VolScaled, TS-12M)
        // already do this; a corrupt bar (negative/NaN/Infinite price) previously flowed into
        // finite-but-garbage factor z-scores that could emit a vote.
        Bar[] bars = ctx == null ? null : ctx.primaryBars();
        if (bars == null || !allPricesFinite(bars)) {
            conditionsFailed.add(ctx == null || bars == null
                ? "No bar context provided - no signal by construction."
                : "Bar history contains non-finite or non-positive prices - no signal by construction.");
            return new StrategyEvaluation(ID, StrategyEvaluation.Side.HOLD, 0, 0.0,
                false, // degenerate input: HOLD, never a directional signal
                conditionsMet, conditionsFailed, contradictions,
                List.of(), LevelSuggestion.none("No signal."), LevelSuggestion.none("No signal."),
                List.of("ANY_REGIME"));
        }

        FactorAlphaEngine.FactorScores scores = FactorAlphaEngine.compute(
            bars, MOMENTUM_DAYS, SMA_WINDOW, Z_SCORE_WINDOW);

        if (scores == null) {
            conditionsFailed.add("Not enough bar history for the requested factor windows.");
            return new StrategyEvaluation(ID, StrategyEvaluation.Side.HOLD, 0, 0.0,
                false, // insufficient history: no signal by construction
                conditionsMet, conditionsFailed, contradictions,
                List.of(), LevelSuggestion.none("No signal."), LevelSuggestion.none("No signal."),
                List.of("ANY_REGIME"));
        }

        // DEFECT FIX (2026-10-05): NaN composite previously fell through to side=SELL
        // (NaN >= 0 is false). Degenerate factor output is now HOLD, matching the siblings'
        // noSignal pattern — a missing computation must never become a directional signal.
        if (Double.isNaN(scores.composite())) {
            conditionsFailed.add("Factor composite is NaN (degenerate input statistics) - no signal by construction.");
            return new StrategyEvaluation(ID, StrategyEvaluation.Side.HOLD, 0, 0.0,
                false,
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

        boolean triggerMet = Math.abs(scores.composite()) >= ENTRY_COMPOSITE_THRESHOLD;
        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            triggerMet, // trigger: composite factor score beyond the entry threshold
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

    /** Bar hygiene: all OHLC prices finite and closes/opens positive. */
    private static boolean allPricesFinite(Bar[] bars) {
        for (Bar b : bars) {
            if (!Double.isFinite(b.close()) || !Double.isFinite(b.open())
                    || !Double.isFinite(b.high()) || !Double.isFinite(b.low())
                    || b.close() <= 0 || b.open() <= 0) return false;
        }
        return true;
    }
}
