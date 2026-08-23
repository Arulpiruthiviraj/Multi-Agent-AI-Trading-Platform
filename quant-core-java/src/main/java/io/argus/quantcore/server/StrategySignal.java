package io.argus.quantcore.server;

/** Matches docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md §3.3 exactly. */
public record StrategySignal(
    int schemaVersion,
    String symbol,
    String side,
    double confidence,
    String strategyId,
    String reasoning,
    double currentPrice,
    boolean regimeMismatchDiscounted,
    boolean evSuppressed
) {
}
