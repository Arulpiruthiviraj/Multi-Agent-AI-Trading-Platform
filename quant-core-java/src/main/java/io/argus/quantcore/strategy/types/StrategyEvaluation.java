package io.argus.quantcore.strategy.types;

import java.util.List;

/** Mirrors src/server/quant/strategies/types.ts's {@code StrategyEvaluation} exactly. */
public record StrategyEvaluation(
    String strategy,
    Side side,
    int setupScore,       // 0-100
    double confidence,    // 0-1, == setupScore / 100 at the strategy layer (blending happens upstream)
    /**
     * Whether the strategy's DEFINING trigger event actually occurred on this bar.
     * TS StrategyEngine caps confidence below the trade bar when false; Java consumers
     * must apply the same gate (see CoreStrategyRunner).
     */
    boolean triggerMet,
    List<String> conditionsMet,
    List<String> conditionsFailed,
    List<String> contradictions,
    List<String> invalidationConditions,
    LevelSuggestion stop,
    LevelSuggestion target,
    List<String> applicableRegimes
) {
    public enum Side { BUY, SELL, HOLD }
}
