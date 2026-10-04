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
    double slippagePct,
    /** P1-7 (2026-10-04 remediation): true only for a position force-closed at the final bar
     *  because the backtest window ended while it was still open - distinguishes an exposure the
     *  loop simply ran out of data for from a real signal/stop-driven exit. Metrics must include
     *  it (never silently drop the exposure); callers that need signal-only trades can filter on
     *  this field. */
    boolean terminalLiquidation
) {
    /** Convenience for every pre-existing call site: a normal signal/stop-driven exit. */
    public TradeRecord(String symbol, long entryTimestampMs, double entryPrice, long exitTimestampMs,
                        double exitPrice, double quantity, double pnl, double commission, double slippagePct) {
        this(symbol, entryTimestampMs, entryPrice, exitTimestampMs, exitPrice, quantity, pnl, commission, slippagePct, false);
    }
}
