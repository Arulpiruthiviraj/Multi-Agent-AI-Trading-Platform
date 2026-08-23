package io.argus.quantcore.backtest.engine;

public record TradeRecord(
    String symbol,
    long entryTimestampMs,
    double entryPrice,
    long exitTimestampMs,
    double exitPrice,
    double quantity,
    double pnl,
    double commission,
    double slippagePct
) {
}
