package io.argus.quantcore.server;

/** Matches docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md §3.1 exactly. */
public record TickEnvelope(
    int schemaVersion,
    String symbol,
    long timestampMs,
    double price,
    Double volume,
    Double bidPrice,
    Double askPrice
) {
}
