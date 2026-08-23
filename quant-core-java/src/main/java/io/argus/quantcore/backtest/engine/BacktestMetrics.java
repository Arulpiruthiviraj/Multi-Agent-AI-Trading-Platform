package io.argus.quantcore.backtest.engine;

import java.util.List;

/** Standard trade-list metrics — net P&L, win rate, profit factor, max drawdown on the trade-level equity curve. */
public final class BacktestMetrics {

    public record Result(
        double netPnl,
        int tradeCount,
        int winCount,
        int lossCount,
        double winRatePct,
        double profitFactor,
        double maxDrawdownPct
    ) {
    }

    private BacktestMetrics() {
    }

    public static Result compute(List<TradeRecord> trades, double startingCash) {
        if (trades.isEmpty()) {
            return new Result(0, 0, 0, 0, 0, 0, 0);
        }
        double netPnl = 0;
        double grossProfit = 0;
        double grossLoss = 0;
        int wins = 0, losses = 0;

        double equity = startingCash;
        double peak = startingCash;
        double maxDrawdownPct = 0;

        for (TradeRecord t : trades) {
            netPnl += t.pnl();
            if (t.pnl() > 0) {
                grossProfit += t.pnl();
                wins++;
            } else if (t.pnl() < 0) {
                grossLoss += Math.abs(t.pnl());
                losses++;
            }
            equity += t.pnl();
            peak = Math.max(peak, equity);
            double drawdownPct = peak > 0 ? (peak - equity) / peak * 100 : 0;
            maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
        }

        double profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Double.POSITIVE_INFINITY : 0);
        double winRatePct = trades.size() > 0 ? (wins / (double) trades.size()) * 100 : 0;

        return new Result(netPnl, trades.size(), wins, losses, winRatePct, profitFactor, maxDrawdownPct);
    }
}
