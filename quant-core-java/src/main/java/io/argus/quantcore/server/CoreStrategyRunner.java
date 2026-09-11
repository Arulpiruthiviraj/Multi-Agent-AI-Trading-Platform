package io.argus.quantcore.server;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.institutional.models.QuantEnsembleEngine;
import io.argus.quantcore.strategy.StrategyRegistry;
import io.argus.quantcore.strategy.types.StrategyContext;
import io.argus.quantcore.strategy.types.StrategyEvaluation;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Real, bars-owning execution path for the 5 CORE strategies (added 2026-09-10, closing the gap
 * docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md §0/§21 identified). Deliberately
 * DISTINCT from {@code QuantCoreServer.handleEvaluate}/{@code StrategyContextCodec}, which decodes
 * a pre-built {@code StrategyContext} JSON body a TS caller would have to construct — that path
 * only ever proves decision-logic parity given identical inputs, never that Java computed its own
 * features. This class takes raw {@code Bar[]} and computes every feature via
 * {@code io.argus.quantcore.features.*} + {@code MomentumFeatures} through
 * {@link FeaturesToStrategyContextAdapter} — Java owns the computation, TS only supplies market
 * data (the same role it already plays for {@code JavaQuantAdvisoryService}'s proven, live
 * {@code fetchInstitutionalFactors}/{@code fetchResearchStrategy} bars-based pattern).
 *
 * Strategy family classification is NOT invented here — it is copied verbatim from
 * src/server/quant/strategyFamilies.ts's CORE_STRATEGY_FAMILIES so the correlation math run
 * through QuantEnsembleEngine (below) is measuring the same families the TS side already uses.
 */
public final class CoreStrategyRunner {

    public static final String[] CORE_STRATEGY_IDS = {
        "MOMENTUM_BREAKOUT", "PULLBACK_CONTINUATION", "MEAN_REVERSION", "TREND_FOLLOWING", "RANGE_REVERSION"
    };

    /** Verbatim copy of strategyFamilies.ts's CORE_STRATEGY_FAMILIES — do not diverge from the TS source. */
    private static final Map<String, String> STRATEGY_FAMILY = Map.of(
        "MOMENTUM_BREAKOUT", "BREAKOUT_VOLATILITY",
        "PULLBACK_CONTINUATION", "TREND_MOMENTUM",
        "MEAN_REVERSION", "MEAN_REVERSION_FAMILY",
        "TREND_FOLLOWING", "TREND_MOMENTUM",
        "RANGE_REVERSION", "MEAN_REVERSION_FAMILY"
    );

    /** Bumped whenever computeTrendFeatures/MomentumFeatures/etc.'s formulas change materially -
     *  not the same as strategyVersion (the strategies' own decision-logic version). */
    public static final String FEATURE_VERSION = "features-2026-09-10";
    public static final String STRATEGY_VERSION = "core-2026-08-21";

    public enum DataQuality { FRESH, STALE, INSUFFICIENT_HISTORY }

    public record Assessment(
        String strategyId,
        String strategyVersion,
        String featureVersion,
        String symbol,
        String direction,      // BUY | SELL | DATA_UNAVAILABLE - never a fabricated HOLD (see class header)
        Integer score,
        Double confidence,
        String reason,
        String regime,
        DataQuality dataQuality,
        long evaluationTimestampMs,
        long latencyMs
    ) {
    }

    /** MIN_BARS mirrors the coarsest real requirement among the 5 strategies' own feature
     *  dependencies (DMI/SMA200 need the most history); a strategy with lighter requirements simply
     *  sees more null optional fields, per every features.* class's own null-when-insufficient
     *  contract - never a fabricated approximation. */
    private static final int MIN_BARS = 210;
    private static final long STALE_BAR_AGE_MS = 5 * 24 * 60 * 60 * 1000L; // 5 trading days - bars-based path, not tick-based

    private CoreStrategyRunner() {
    }

    public static boolean isCoreStrategy(String strategyId) {
        return STRATEGY_FAMILY.containsKey(strategyId);
    }

    public static Assessment evaluate(String strategyId, String symbol, List<Bar> bars,
                                       FeaturesToStrategyContextAdapter.BenchmarkBars benchmarks) {
        long start = System.nanoTime();
        long now = System.currentTimeMillis();

        if (bars == null || bars.size() < MIN_BARS) {
            return new Assessment(strategyId, STRATEGY_VERSION, FEATURE_VERSION, symbol,
                "DATA_UNAVAILABLE", null, null,
                "insufficient bar history: " + (bars == null ? 0 : bars.size()) + " < " + MIN_BARS,
                null, DataQuality.INSUFFICIENT_HISTORY, now, elapsedMs(start));
        }

        long lastBarAgeMs = now - bars.get(bars.size() - 1).timestampMs();
        DataQuality dataQuality = lastBarAgeMs > STALE_BAR_AGE_MS ? DataQuality.STALE : DataQuality.FRESH;

        StrategyContext ctx = FeaturesToStrategyContextAdapter.build(symbol, bars, "1Day", benchmarks);
        var evalOpt = StrategyRegistry.evaluate(strategyId, ctx);
        if (evalOpt.isEmpty()) {
            return new Assessment(strategyId, STRATEGY_VERSION, FEATURE_VERSION, symbol,
                "DATA_UNAVAILABLE", null, null, "unknown or non-CORE strategyId: " + strategyId,
                ctx.regime() == null ? null : ctx.regime().regime(), dataQuality, now, elapsedMs(start));
        }
        StrategyEvaluation eval = evalOpt.get();
        return new Assessment(strategyId, STRATEGY_VERSION, FEATURE_VERSION, symbol,
            eval.side().name(), eval.setupScore(), eval.confidence(),
            "QuantCoreJava/" + strategyId + ": setupScore " + eval.setupScore()
                + " (" + eval.conditionsMet().size() + " met, " + eval.conditionsFailed().size() + " failed)",
            ctx.regime() == null ? null : ctx.regime().regime(), dataQuality, now, elapsedMs(start));
    }

    public enum EnsembleStatus { HEALTHY, DEGRADED, UNAVAILABLE }

    public record EnsembleDecision(
        EnsembleStatus status,
        String direction,           // BUY | SELL | HOLD - status carries unavailability, never this field
        double score,
        double confidence,
        String reason,
        String regime,
        long timestampMs,
        String featureVersion,
        String strategyVersion,
        int strategyCount,
        int agreeingCount,
        double effectiveIndependentCount,
        List<String> contributingStrategies,
        List<String> contributingFamilies,
        List<Assessment> assessments
    ) {
    }

    /**
     * Runs every id in CORE_STRATEGY_IDS through {@link #evaluate} and combines the results via
     * the EXISTING QuantEnsembleEngine.combine() (Kish/Grinold-Kahn effective-independent-count
     * math) - no second correlation system, per this codebase's own standing rule. status is
     * strictly separate from direction: HOLD is a real ensemble outcome (evaluated, no side
     * commanded a majority), UNAVAILABLE means nothing could be evaluated at all - never conflated.
     */
    public static EnsembleDecision runEnsemble(String symbol, List<Bar> bars,
                                                FeaturesToStrategyContextAdapter.BenchmarkBars benchmarks) {
        long now = System.currentTimeMillis();
        List<Assessment> assessments = new ArrayList<>();
        for (String id : CORE_STRATEGY_IDS) {
            assessments.add(evaluate(id, symbol, bars, benchmarks));
        }

        List<Assessment> usable = assessments.stream()
            .filter(a -> !"DATA_UNAVAILABLE".equals(a.direction()))
            .toList();

        if (usable.isEmpty()) {
            return new EnsembleDecision(EnsembleStatus.UNAVAILABLE, "HOLD", 0, 0,
                "no CORE strategy could be evaluated - " + assessments.get(0).reason(),
                null, now, FEATURE_VERSION, STRATEGY_VERSION, assessments.size(), 0, 0,
                List.of(), List.of(), assessments);
        }

        QuantEnsembleEngine.ModelVote[] votes = new QuantEnsembleEngine.ModelVote[usable.size()];
        for (int i = 0; i < usable.size(); i++) {
            Assessment a = usable.get(i);
            QuantEnsembleEngine.Side side = "BUY".equals(a.direction()) ? QuantEnsembleEngine.Side.BUY
                : "SELL".equals(a.direction()) ? QuantEnsembleEngine.Side.SELL : QuantEnsembleEngine.Side.NEUTRAL;
            votes[i] = new QuantEnsembleEngine.ModelVote(a.strategyId(), STRATEGY_FAMILY.get(a.strategyId()), side, a.confidence());
        }
        QuantEnsembleEngine.EnsembleResult ensemble = QuantEnsembleEngine.combine(votes);

        String direction = ensemble.rawSide() == QuantEnsembleEngine.Side.BUY ? "BUY"
            : ensemble.rawSide() == QuantEnsembleEngine.Side.SELL ? "SELL" : "HOLD";
        EnsembleStatus status = usable.size() < assessments.size() ? EnsembleStatus.DEGRADED : EnsembleStatus.HEALTHY;

        List<String> families = new ArrayList<>();
        for (String modelId : ensemble.agreeingModelIds()) {
            String fam = STRATEGY_FAMILY.get(modelId);
            if (fam != null && !families.contains(fam)) families.add(fam);
        }

        String regime = usable.get(0).regime();

        return new EnsembleDecision(status, direction, ensemble.avgConfidenceOfAgreeing(), ensemble.avgConfidenceOfAgreeing(),
            ensemble.agreeingCount() + "/" + ensemble.totalVotes() + " CORE strategies agree on " + direction
                + " (effective independent count " + String.format("%.2f", ensemble.effectiveIndependentCount()) + ")",
            regime, now, FEATURE_VERSION, STRATEGY_VERSION,
            assessments.size(), ensemble.agreeingCount(), ensemble.effectiveIndependentCount(),
            List.of(ensemble.agreeingModelIds()), families, assessments);
    }

    private static long elapsedMs(long startNanos) {
        return (System.nanoTime() - startNanos) / 1_000_000;
    }
}
