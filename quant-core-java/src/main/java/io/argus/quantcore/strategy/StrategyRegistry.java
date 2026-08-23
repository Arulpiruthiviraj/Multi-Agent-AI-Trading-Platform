package io.argus.quantcore.strategy;

import io.argus.quantcore.strategy.core.*;
import io.argus.quantcore.strategy.types.StrategyContext;
import io.argus.quantcore.strategy.types.StrategyEvaluation;

import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

/**
 * Mirrors src/server/quant/strategies/StrategyEngine.ts's {@code findStrategy(id)} dispatcher —
 * CORE only in this Phase 1 pass (the 15 experimental strategies are explicitly out of scope
 * here per the migration blueprint's P2 priority; adding them later means adding entries to this
 * map, not restructuring it).
 */
public final class StrategyRegistry {

    private static final Map<String, Function<StrategyContext, StrategyEvaluation>> CORE = Map.of(
        MomentumBreakout.ID, ctx -> new MomentumBreakout().evaluate(ctx),
        PullbackContinuation.ID, ctx -> new PullbackContinuation().evaluate(ctx),
        MeanReversion.ID, ctx -> new MeanReversion().evaluate(ctx),
        TrendFollowing.ID, ctx -> new TrendFollowing().evaluate(ctx),
        RangeReversion.ID, ctx -> new RangeReversion().evaluate(ctx)
    );

    private StrategyRegistry() {
    }

    public static Optional<StrategyEvaluation> evaluate(String strategyId, StrategyContext ctx) {
        var fn = CORE.get(strategyId);
        return fn == null ? Optional.empty() : Optional.of(fn.apply(ctx));
    }

    public static boolean isCoreStrategy(String strategyId) {
        return CORE.containsKey(strategyId);
    }
}
