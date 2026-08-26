package io.argus.quantcore.backtest.engine;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * ACTIVE, but scope-limited to {@link RsiThresholdStrategy} only (marked per CLAUDE.md's Java
 * Engine Authority rule 8, found unmarked during the 2026-08-25 post-audit hardening pass).
 * SignalDrivenBacktest.java (added 2026-08-24) is the generic, multi-strategy successor for any
 * new strategy backtest (see GraduationHarness.java's registry) - this class was not replaced or
 * deprecated, since RsiThresholdStrategy's own concurrent-multi-symbol runner still has real
 * callers, but no NEW strategy should be wired into this class going forward.
 *
 * Runs {@link RsiThresholdStrategy} across multiple symbols concurrently using Java 26 virtual
 * threads (one virtual thread per symbol — cheap enough that "one per symbol" needs no pooling
 * tuning even at hundreds of symbols). Research/CLI only: no live wiring, cannot write to any
 * live/paper runtime database (SqliteBarLoader is read-only).
 */
public final class JavaBacktestEngine {

    public record SymbolResult(String symbol, List<TradeRecord> trades, BacktestMetrics.Result metrics, int barsProcessed) {
    }

    public record RunResult(Map<String, SymbolResult> bySymbol, long totalBarsProcessed, long durationNanos) {
    }

    public RunResult run(Map<String, List<Bar>> barsBySymbol, double startingCashPerSymbol, double positionSizeFraction) throws InterruptedException {
        long start = System.nanoTime();
        Map<String, SymbolResult> results = new ConcurrentHashMap<>();

        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<?>> futures = new java.util.ArrayList<>();
            for (var entry : barsBySymbol.entrySet()) {
                String symbol = entry.getKey();
                List<Bar> bars = entry.getValue();
                Future<?> future = executor.submit((Runnable) () -> {
                    List<TradeRecord> trades = new RsiThresholdStrategy().run(symbol, bars, startingCashPerSymbol, positionSizeFraction);
                    BacktestMetrics.Result metrics = BacktestMetrics.compute(trades, startingCashPerSymbol);
                    results.put(symbol, new SymbolResult(symbol, trades, metrics, bars.size()));
                });
                futures.add(future);
            }
            for (Future<?> f : futures) {
                try {
                    f.get();
                } catch (Exception e) {
                    throw new RuntimeException("Backtest task failed", e);
                }
            }
        }

        long totalBars = results.values().stream().mapToLong(SymbolResult::barsProcessed).sum();
        return new RunResult(results, totalBars, System.nanoTime() - start);
    }
}
