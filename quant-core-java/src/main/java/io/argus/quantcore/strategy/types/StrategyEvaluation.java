package io.argus.quantcore.strategy.types;

import java.util.List;

/** Mirrors src/server/quant/strategies/types.ts's {@code StrategyEvaluation} exactly. */
public record StrategyEvaluation(
    String strategy,
    Side side,
    int setupScore,       // 0-100
    double confidence,    // 0-1, == setupScore / 100 at the strategy layer (blending happens upstream)
    List<String> conditionsMet,
    List<String> conditionsFailed,
    List<String> contradictions,
    List<String> invalidationConditions,
    LevelSuggestion stop,
    LevelSuggestion target,
    List<String> applicableRegimes
) {
    public enum Side { BUY, SELL }
}
