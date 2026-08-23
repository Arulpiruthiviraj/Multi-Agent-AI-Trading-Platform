package io.argus.quantcore.backtest.engine;

/** One OHLCV bar - mirrors the shape of a row in the live schema's {@code ohlcv_bars} table. */
public record Bar(long timestampMs, double open, double high, double low, double close, double volume) {
}
