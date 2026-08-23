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
 * Rule: enter long when 14-period RSI crosses below 30 (oversold) and no position is open; exit
 * when RSI crosses above 55 or a stop-loss (2% below entry) is hit. SAME_BAR_CLOSE fill model,
 * matching src/server/engines/backtest/BacktestEngine.ts's own documented (non-promotable) model.
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
                boolean stopHit = bar.close() <= open.entryPrice() * (1 - STOP_LOSS_PCT);
                boolean targetHit = r > EXIT_RSI;
                if (stopHit || targetHit) {
                    double slipPct = Slippage.calculateDynamicSlippagePct(
                        java.util.Arrays.copyOfRange(highs, 0, i + 1),
                        java.util.Arrays.copyOfRange(lows, 0, i + 1),
                        window, bar.close(), open.quantity(), bar.volume());
                    double fillPrice = bar.close() * (1 - slipPct);
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

        return trades;
    }
}
