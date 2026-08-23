package io.argus.quantcore.server;

/** Matches docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md §3.2 exactly. */
public record IndicatorSnapshot(
    int schemaVersion,
    String symbol,
    long asOfTimestampMs,
    Double rsi,
    Double macd,
    Double macdSignal,
    Double bbUpper,
    Double bbLower,
    Double atr,
    Double vwap,
    String regime,
    boolean insufficientHistory
) {
}
