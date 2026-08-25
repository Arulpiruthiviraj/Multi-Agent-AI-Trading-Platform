package io.argus.quantcore.backtest.cli;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.backtest.engine.BacktestMetrics;
import io.argus.quantcore.backtest.engine.SignalDrivenBacktest;
import io.argus.quantcore.backtest.engine.SignalDrivenBacktest.Signal;
import io.argus.quantcore.backtest.engine.TradeRecord;
import io.argus.quantcore.backtest.loader.SqliteBarLoader;
import io.argus.quantcore.institutional.models.MeanReversionZScoreEngine;
import io.argus.quantcore.institutional.models.TimeSeriesMomentumEngine;

import java.util.ArrayList;
import java.util.List;

/**
 * Real BACKTEST-stage graduation exercise for 2 of the 37 new institutional Java modules
 * (2026-08-24 readiness audit, Part 9). Deliberately NOT a reflection/plugin-scanning system - an
 * explicit, hand-written registry, matching the audit's own "explicit registry metadata" requirement.
 *
 * Both modules remain RESEARCH in config/engineOwnership.json after this run - a backtest, even a
 * positive one, is never sufficient for promotion (this file's own report says so explicitly). No
 * live wiring anywhere here; SqliteBarLoader is read-only; this never places or influences a real
 * order.
 *
 * Reuses SAME_BAR_CLOSE-style fill/slippage/commission accounting (SignalDrivenBacktest.java),
 * the same non-promotable research fill model this module's other backtest tooling already uses -
 * see CLAUDE.md's "Research fill models" section for why that model is explicitly not the
 * promotion-adjacent one (that's canonicalNextBarEngine.ts, TypeScript-side, not this harness).
 */
public final class GraduationHarness {

    /** Real, hand-registered strategy metadata - the "explicit registry" the audit asked for instead of a generic plugin system. */
    public record RegisteredStrategy(String id, String description, int minWarmupBars, SignalDrivenBacktest.SignalFunction signalFn) {
    }

    private static Signal timeSeriesMomentumSignal(double[] closes) {
        TimeSeriesMomentumEngine.Result r = TimeSeriesMomentumEngine.evaluate(closes, 20, 60, 252);
        if (r.signal() == null) return Signal.NEUTRAL;
        return switch (r.signal()) {
            case BUY -> Signal.BUY;
            case SELL -> Signal.SELL;
            case NEUTRAL -> Signal.NEUTRAL;
        };
    }

    private static Signal meanReversionZScoreSignal(double[] closes) {
        MeanReversionZScoreEngine.Result r = MeanReversionZScoreEngine.evaluate(closes, 20, 2.0);
        if (r == null) return Signal.NEUTRAL;
        return switch (r.fadeSignal()) {
            case "BUY" -> Signal.BUY;
            case "SELL" -> Signal.SELL;
            default -> Signal.NEUTRAL;
        };
    }

    public static List<RegisteredStrategy> registry() {
        List<RegisteredStrategy> list = new ArrayList<>();
        list.add(new RegisteredStrategy(
            "TIME_SERIES_MOMENTUM_ENGINE", "20/60/252-bar time-series momentum (Two-Sigma-style catalog item)",
            253, (closes, idx) -> timeSeriesMomentumSignal(closes)));
        list.add(new RegisteredStrategy(
            "MEAN_REVERSION_ZSCORE_ENGINE", "20-bar rolling Z-score fade at |z| >= 2.0",
            21, (closes, idx) -> meanReversionZScoreSignal(closes)));
        return list;
    }

    private static void printMetrics(String label, BacktestMetrics.Result m, List<TradeRecord> trades) {
        double avgHoldingBars = trades.isEmpty() ? 0 :
            trades.stream().mapToLong(t -> (t.exitTimestampMs() - t.entryTimestampMs())).average().orElse(0) / 86_400_000.0;
        // Simple per-trade-return Sharpe (not daily) - honestly labeled as such, not disguised as an
        // annualized daily Sharpe, which would require an equity curve this harness does not build.
        double sharpe = 0;
        if (trades.size() > 1) {
            double[] rets = trades.stream().mapToDouble(TradeRecord::pnl).toArray();
            double mean = java.util.Arrays.stream(rets).average().orElse(0);
            double variance = java.util.Arrays.stream(rets).map(r -> (r - mean) * (r - mean)).average().orElse(0);
            double sd = Math.sqrt(variance);
            sharpe = sd > 0 ? mean / sd : 0;
        }
        System.out.printf("  [%s] trades=%d winRate=%.1f%% profitFactor=%s netPnl=%.2f maxDD=%.2f%% avgHoldDays=%.1f perTradeSharpe=%.3f%n",
            label, m.tradeCount(), m.winRatePct(),
            Double.isInfinite(m.profitFactor()) ? "inf" : String.format("%.2f", m.profitFactor()),
            m.netPnl(), m.maxDrawdownPct(), avgHoldingBars, sharpe);
    }

    public static void main(String[] args) throws Exception {
        String dbPath = args.length > 0 ? args[0] : "../data/argus.db";
        String[] symbols = {"AAPL", "NVDA", "SPY", "MSFT", "AMD"};
        double startingCash = 100_000;
        double positionSizeFraction = 0.10;

        try (SqliteBarLoader loader = new SqliteBarLoader(dbPath)) {
            for (RegisteredStrategy strat : registry()) {
                System.out.println("=== " + strat.id() + " - " + strat.description() + " ===");
                System.out.println("Status: RESEARCH (unchanged by this run - a backtest never auto-promotes)");
                for (String symbol : symbols) {
                    List<Bar> bars = loader.loadBars(symbol, "1Day", 0, Long.MAX_VALUE);
                    if (bars.size() < strat.minWarmupBars() + 30) {
                        System.out.printf("  %s: SKIPPED - only %d bars available, need >= %d for a meaningful in-sample/out-of-sample split%n",
                            symbol, bars.size(), strat.minWarmupBars() + 30);
                        continue;
                    }
                    int splitIdx = (int) (bars.size() * 0.70);
                    List<Bar> inSample = bars.subList(0, splitIdx);
                    List<Bar> outOfSample = bars.subList(splitIdx, bars.size());

                    List<TradeRecord> isTrades = SignalDrivenBacktest.run(symbol, inSample, startingCash, positionSizeFraction, strat.minWarmupBars(), strat.signalFn());
                    List<TradeRecord> oosTrades = SignalDrivenBacktest.run(symbol, outOfSample, startingCash, positionSizeFraction, strat.minWarmupBars(), strat.signalFn());
                    BacktestMetrics.Result isMetrics = BacktestMetrics.compute(isTrades, startingCash);
                    BacktestMetrics.Result oosMetrics = BacktestMetrics.compute(oosTrades, startingCash);

                    System.out.println(" " + symbol + " (" + bars.size() + " bars, "
                        + new java.util.Date(bars.get(0).timestampMs()) + " to " + new java.util.Date(bars.get(bars.size() - 1).timestampMs()) + "):");
                    printMetrics("IN-SAMPLE  (first 70%)", isMetrics, isTrades);
                    printMetrics("OUT-OF-SAMPLE (last 30%)", oosMetrics, oosTrades);
                }
                System.out.println();
            }
        }
    }
}
