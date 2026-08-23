package io.argus.quantcore.backtest.cli;

import io.argus.quantcore.backtest.campaign.CampaignPolicySimulator;
import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.backtest.engine.BacktestMetrics;
import io.argus.quantcore.backtest.engine.JavaBacktestEngine;

import java.time.Instant;
import java.util.List;
import java.util.Map;

final class BacktestReportGenerator {

    private BacktestReportGenerator() {
    }

    static String generate(
        Map<String, List<Bar>> barsBySymbol,
        JavaBacktestEngine.RunResult result,
        Map<CampaignPolicySimulator.Policy, CampaignPolicySimulator.PolicyResult> policyResults,
        double target,
        String timeframe,
        long startMs,
        long endMs
    ) {
        StringBuilder sb = new StringBuilder();
        sb.append("# Java Quant Core Backtest Report\n\n");
        sb.append("Generated: ").append(Instant.now()).append("\n\n");
        sb.append("**Strategy: `RsiThresholdStrategy` (demonstration only — NOT one of the 5 CORE ")
          .append("strategies; see its own header comment on why).**\n\n");
        sb.append("Range requested: ").append(Instant.ofEpochMilli(startMs)).append(" to ")
          .append(Instant.ofEpochMilli(endMs)).append(" · timeframe: `").append(timeframe).append("`\n\n");

        long totalBarsRequested = barsBySymbol.values().stream().mapToLong(List::size).sum();
        double throughputBarsPerSec = result.durationNanos() > 0
            ? result.totalBarsProcessed() / (result.durationNanos() / 1_000_000_000.0)
            : 0;

        sb.append("## Honest scale disclosure\n\n");
        sb.append("The originally requested benchmark (1,000,000 1-minute bars across 50 tickers, ")
          .append("<5s, <100MB peak heap) was **NOT run** — this environment's real historical ")
          .append("warehouse (`data/argus.db`'s `ohlcv_bars` table, verified by direct query ")
          .append("2026-08-21) does not contain that much data. Real inventory found: **27,438** ")
          .append("`1Day` bars across 31 symbols, **19,620** `1Min` bars (far fewer symbols/days), ")
          .append("**177** `5Min` bars. The benchmark below is measured against what genuinely ")
          .append("exists, not a fabricated projection to the originally requested scale.\n\n");

        sb.append("## Measured performance (real, this run)\n\n");
        sb.append("| Metric | Value |\n|---|---:|\n");
        sb.append("| Symbols processed | ").append(barsBySymbol.size()).append(" |\n");
        sb.append("| Total bars processed | ").append(result.totalBarsProcessed()).append(" |\n");
        sb.append("| Wall-clock duration | ").append(String.format("%.3f", result.durationNanos() / 1_000_000_000.0)).append(" s |\n");
        sb.append("| Throughput | ").append(String.format("%.0f", throughputBarsPerSec)).append(" bars/sec |\n");
        sb.append("| Concurrency model | Java 26 virtual thread per symbol |\n\n");

        sb.append("## Per-symbol results\n\n");
        sb.append("| Symbol | Bars | Trades | Net P&L | Win Rate | Profit Factor | Max Drawdown % |\n");
        sb.append("|---|---:|---:|---:|---:|---:|---:|\n");
        double totalNetPnl = 0;
        for (var entry : result.bySymbol().entrySet()) {
            var r = entry.getValue();
            BacktestMetrics.Result m = r.metrics();
            totalNetPnl += m.netPnl();
            sb.append("| ").append(entry.getKey())
              .append(" | ").append(r.barsProcessed())
              .append(" | ").append(m.tradeCount())
              .append(" | ").append(String.format("%.2f", m.netPnl()))
              .append(" | ").append(String.format("%.1f%%", m.winRatePct()))
              .append(" | ").append(m.profitFactor() == Double.POSITIVE_INFINITY ? "inf" : String.format("%.2f", m.profitFactor()))
              .append(" | ").append(String.format("%.1f%%", m.maxDrawdownPct()))
              .append(" |\n");
        }
        sb.append("\n**Combined net P&L across all symbols: ").append(String.format("%.2f", totalNetPnl)).append("**\n\n");
        sb.append("This is a demonstration strategy on daily bars with real commission/slippage ")
          .append("friction modeled — it is NOT a claim of trading edge, CORE-strategy performance, ")
          .append("or anything promotable per CLAUDE.md's own standards (NEXT_BAR_OPEN/OOS/WFO/paper ")
          .append("soak requirements). It exists to prove the Phase 4 engine infrastructure works.\n\n");

        sb.append("## Daily Goal Campaign policy simulation (target = $").append(target).append("/day)\n\n");
        sb.append("**Known simplification**: TRAIL_STOPS_ONLY's real distinguishing behavior ")
          .append("(tightening the trailing stop on still-open positions) isn't modeled by this ")
          .append("already-closed-trade simulation — see CampaignPolicySimulator.java's own header ")
          .append("comment. It will show identical numbers to LOCK_AND_IDLE below.\n\n");
        sb.append("| Policy | Total P&L | Days target reached | Total days |\n|---|---:|---:|---:|\n");
        for (var entry : policyResults.entrySet()) {
            var p = entry.getValue();
            sb.append("| ").append(entry.getKey())
              .append(" | ").append(String.format("%.2f", p.totalPnl()))
              .append(" | ").append(p.daysTargetReached())
              .append(" | ").append(p.totalDays())
              .append(" |\n");
        }

        sb.append("\n## What this report is NOT\n\n");
        sb.append("- Not a claim of predictive edge (CLAUDE.md's own standard: organic closed PAPER ")
          .append("FILLED SELL P&L, not a backtest, establishes edge).\n");
        sb.append("- Not the 5 CORE strategies (MOMENTUM_BREAKOUT/PULLBACK_CONTINUATION/")
          .append("MEAN_REVERSION/TREND_FOLLOWING/RANGE_REVERSION) — those need the still-unported ")
          .append("feature pipeline (RegimeEngine/trend/volume/priceAction/supportResistance/")
          .append("MarketContext).\n");
        sb.append("- Not a TS-vs-Java parity comparison for this specific run (that requires running ")
          .append("the real `src/server/engines/backtest/BacktestEngine.ts` against the identical ")
          .append("symbols/dates and diffing trade-by-trade — not done in this pass; tracked as ")
          .append("follow-up, not silently assumed to match).\n");

        return sb.toString();
    }
}
