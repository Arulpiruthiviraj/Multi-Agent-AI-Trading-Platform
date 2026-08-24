package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.institutional.models.StatArbEngine;
import io.argus.quantcore.strategy.types.LevelSuggestion;
import io.argus.quantcore.strategy.types.StrategyEvaluation;

import java.util.ArrayList;
import java.util.List;

/**
 * Pairs-trading decision logic: Engle-Granger cointegration + spread Z-score (see StatArbEngine).
 * Convention: {@code side=BUY} means primarySymbol is the LONG leg of this pair trade (the
 * spread is below its equilibrium - primary looks cheap relative to pairSymbol at the fitted
 * hedge ratio, expect it to rise back toward the pair); {@code side=SELL} is the mirror case.
 *
 * This module is research/quant-core infrastructure only - it is not wired into the live trading
 * spine. A real pair trade requires shorting one leg, which this codebase's live brokers do not
 * support (AlpacaBroker.getCapabilities().shortSelling == false); wiring this in would need its
 * own explicit, gated phase, matching how the 5 CORE strategies were ported (Phase 1) well before
 * being wired live (Phase 2/3).
 */
public final class InstitutionalStatArbStrategy {

    public static final String ID = "INSTITUTIONAL_STAT_ARB";

    private static final double ENTRY_Z_THRESHOLD = 2.0;
    private static final double MAX_HALF_LIFE_BARS = 60.0;

    public StrategyEvaluation evaluate(InstitutionalStrategyContext ctx) {
        List<String> conditionsMet = new ArrayList<>();
        List<String> conditionsFailed = new ArrayList<>();
        List<String> contradictions = new ArrayList<>();

        if (ctx.pairBars() == null || ctx.pairSymbol() == null) {
            conditionsFailed.add("No pair symbol/bars configured for StatArb evaluation.");
            return noSignal(conditionsMet, conditionsFailed, contradictions);
        }

        double[] primaryClose = closes(ctx.primaryBars());
        double[] pairClose = closes(ctx.pairBars());
        StatArbEngine.PairResult result = StatArbEngine.evaluatePair(primaryClose, pairClose, 60);

        if (result == null) {
            conditionsFailed.add("Not enough aligned history to fit and ADF-test the pair spread.");
            return noSignal(conditionsMet, conditionsFailed, contradictions);
        }

        check(conditionsMet, conditionsFailed,
            "Pair spread rejects the unit-root null (Engle-Granger cointegration, ADF at 5%)",
            result.cointegrated());

        boolean hasZ = result.currentZScore() != null;
        check(conditionsMet, conditionsFailed, "Current spread Z-score is computable", hasZ);

        boolean extended = hasZ && Math.abs(result.currentZScore()) >= ENTRY_Z_THRESHOLD;
        check(conditionsMet, conditionsFailed,
            "Spread is extended beyond +/-" + ENTRY_Z_THRESHOLD + " sigma (an entry-worthy deviation)",
            extended);

        boolean reasonableHalfLife = result.halfLifeBars() != null
            && result.halfLifeBars() > 0
            && result.halfLifeBars() <= MAX_HALF_LIFE_BARS;
        check(conditionsMet, conditionsFailed,
            "OU half-life is positive and within " + (int) MAX_HALF_LIFE_BARS + " bars (reverts on a tradeable horizon)",
            reasonableHalfLife);

        if (!result.cointegrated()) {
            contradictions.add("Pair fails the cointegration test this pass - a spread trade here has no statistical basis, regardless of how extended it looks.");
        }

        boolean bullishPrimary = hasZ && result.currentZScore() < 0;
        StrategyEvaluation.Side side = bullishPrimary ? StrategyEvaluation.Side.BUY : StrategyEvaluation.Side.SELL;

        int total = conditionsMet.size() + conditionsFailed.size();
        int setupScore = (result.cointegrated() && extended && reasonableHalfLife)
            ? (int) Math.round(((double) conditionsMet.size() / total) * 100)
            : 0;

        LevelSuggestion stop = LevelSuggestion.none("Pair-spread strategy - stop is a spread-Z-score reversal, not a single-symbol price level.");
        LevelSuggestion target = LevelSuggestion.none("Pair-spread strategy - target is spread reversion to its OU mean, not a single-symbol price level.");

        return new StrategyEvaluation(ID, side, setupScore, setupScore / 100.0,
            conditionsMet, conditionsFailed, contradictions,
            List.of(
                "Spread Z-score crosses back through zero (reversion has completed).",
                "Pair loses cointegration on a subsequent re-test (the relationship itself has broken)."
            ),
            stop, target, List.of("PAIR_COINTEGRATED_RANGE"));
    }

    private StrategyEvaluation noSignal(List<String> met, List<String> failed, List<String> contradictions) {
        return new StrategyEvaluation(ID, StrategyEvaluation.Side.BUY, 0, 0.0,
            met, failed, contradictions,
            List.of(),
            LevelSuggestion.none("No signal."), LevelSuggestion.none("No signal."),
            List.of("PAIR_COINTEGRATED_RANGE"));
    }

    private static void check(List<String> met, List<String> failed, String name, boolean condition) {
        (condition ? met : failed).add(name);
    }

    private static double[] closes(Bar[] bars) {
        double[] out = new double[bars.length];
        for (int i = 0; i < bars.length; i++) out[i] = bars[i].close();
        return out;
    }
}
