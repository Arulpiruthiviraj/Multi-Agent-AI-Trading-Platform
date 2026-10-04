package io.argus.quantcore.backtest.engine;

import io.argus.quantcore.indicators.RSI;

import java.util.ArrayList;
import java.util.List;

/**
 * Demonstration long-only strategy for the Phase 4 backtest engine — NOT one of the 5 CORE
 * strategies (MOMENTUM_BREAKOUT/PULLBACK_CONTINUATION/MEAN_REVERSION/TREND_FOLLOWING/
 * RANGE_REVERSION). Those 5 require a full StrategyContext (trend structure, regime,
 * support/resistance, market context — see StrategyContext.java's own header comment), which
 * needs the upstream feature-computation pipeline (RegimeEngine.ts / trend.ts / volume.ts /
 * priceAction.ts / supportResistance.ts / MarketContext.ts) that was explicitly out of scope for
 * Phase 1's strategy port. This strategy exists to prove the Phase 4 engine infrastructure
 * (loader, parallel virtual-thread runner, ledger, commissions/slippage, campaign simulator)
 * genuinely works end-to-end against real historical bars, using only the Phase 0-ported,
 * self-sufficient RSI indicator (needs closes only, no feature tree). Wiring the 5 CORE
 * strategies into this engine is tracked as follow-up work, not silently assumed done.
 *
 * Rule: enter long when 14-period RSI is below 30 (oversold - a LEVEL condition, not a cross: this
 * checks the current bar's RSI value only, with no comparison against the prior bar) and no
 * position is open; exit when RSI is above 55 (same level-condition semantics) or a stop-loss (2%
 * below entry) is hit. SAME_BAR_CLOSE fill model, matching
 * src/server/engines/backtest/BacktestEngine.ts's own documented (non-promotable) model.
 *
 * P1-13 (2026-10-04 remediation): this doc previously said "crosses below"/"crosses above", which
 * describes a cross condition (prior bar on one side of the threshold, current bar on the other).
 * The actual code (`r < ENTRY_RSI`, `r > EXIT_RSI`) has always been a level condition. Corrected
 * the documentation to match the real, already-researched behavior rather than changing the
 * behavior to match the doc - changing to a true cross here would silently alter this strategy's
 * entry/exit frequency and invalidate any existing research run against it.
 */
public final class RsiThresholdStrategy {

    private static final double ENTRY_RSI = 30;
    private static final double EXIT_RSI = 55;
    private static final double STOP_LOSS_PCT = 0.02;
    private final RSI rsi = new RSI(14);

    public record OpenPosition(int entryIndex, long entryTimestampMs, double entryPrice, double quantity) {
    }

    public List<TradeRecord> run(String symbol, List<Bar> bars, double startingCash, double positionSizeFraction) {
        List<TradeRecord> trades = new ArrayList<>();
        if (bars.size() < 15) {
            return trades;
        }

        double[] closes = new double[bars.size()];
        double[] highs = new double[bars.size()];
        double[] lows = new double[bars.size()];
        for (int i = 0; i < bars.size(); i++) {
            closes[i] = bars.get(i).close();
            highs[i] = bars.get(i).high();
            lows[i] = bars.get(i).low();
        }

        OpenPosition open = null;
        double cash = startingCash;

        for (int i = 14; i < bars.size(); i++) {
            double[] window = java.util.Arrays.copyOfRange(closes, 0, i + 1);
            double r = rsi.calculate(window);
            Bar bar = bars.get(i);

            if (open == null && r < ENTRY_RSI) {
                double notional = cash * positionSizeFraction;
                double quantity = Math.floor(notional / bar.close());
                if (quantity >= 1) {
                    double slipPct = Slippage.calculateDynamicSlippagePct(
                        java.util.Arrays.copyOfRange(highs, 0, i + 1),
                        java.util.Arrays.copyOfRange(lows, 0, i + 1),
                        window, bar.close(), quantity, bar.volume());
                    double fillPrice = bar.close() * (1 + slipPct);
                    open = new OpenPosition(i, bar.timestampMs(), fillPrice, quantity);
                }
            } else if (open != null) {
                // P1-8 (2026-10-04 remediation): see SignalDrivenBacktest.java's identical fix -
                // the stop must trigger on the bar's intrabar low, not only its close.
                double stopPrice = open.entryPrice() * (1 - STOP_LOSS_PCT);
                boolean stopHit = bar.low() <= stopPrice;
                boolean targetHit = r > EXIT_RSI;
                if (stopHit || targetHit) {
                    double exitPrice = stopHit ? stopPrice : bar.close();
                    double slipPct = Slippage.calculateDynamicSlippagePct(
                        java.util.Arrays.copyOfRange(highs, 0, i + 1),
                        java.util.Arrays.copyOfRange(lows, 0, i + 1),
                        window, exitPrice, open.quantity(), bar.volume());
                    double fillPrice = exitPrice * (1 - slipPct);
                    Commissions.Result commission = Commissions.calculate("SELL", open.quantity(), fillPrice);
                    double grossPnl = (fillPrice - open.entryPrice()) * open.quantity();
                    double netPnl = grossPnl - commission.total();
                    trades.add(new TradeRecord(symbol, open.entryTimestampMs(), open.entryPrice(),
                        bar.timestampMs(), fillPrice, open.quantity(), netPnl, commission.total(), slipPct));
                    cash += netPnl;
                    open = null;
                }
            }
        }

        // P1-7 (2026-10-04 remediation): see SignalDrivenBacktest.java's identical fix - a position
        // still open when the window ends must be marked, not silently dropped.
        if (open != null) {
            Bar lastBar = bars.get(bars.size() - 1);
            double slipPct = Slippage.calculateDynamicSlippagePct(highs, lows, closes, lastBar.close(), open.quantity(), lastBar.volume());
            double fillPrice = lastBar.close() * (1 - slipPct);
            Commissions.Result commission = Commissions.calculate("SELL", open.quantity(), fillPrice);
            double grossPnl = (fillPrice - open.entryPrice()) * open.quantity();
            double netPnl = grossPnl - commission.total();
            trades.add(new TradeRecord(symbol, open.entryTimestampMs(), open.entryPrice(),
                lastBar.timestampMs(), fillPrice, open.quantity(), netPnl, commission.total(), slipPct, true));
        }

        return trades;
    }
}
