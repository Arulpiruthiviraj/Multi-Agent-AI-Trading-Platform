package io.argus.quantcore.backtest.engine;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Generic long-only, signal-driven backtest loop (2026-08-24 readiness audit, Part 9) - the same
 * fill/commission/slippage model and entry/exit shape as RsiThresholdStrategy.java, but
 * parameterized by any {@link SignalFunction} instead of a hardcoded RSI rule. This is the
 * "generic backtest harness rather than hardcoding to RsiThresholdStrategy" the audit asked for -
 * deliberately NOT a reflection/plugin-scanning system (see GraduationHarness.java's own explicit,
 * hand-written registry) - just one reusable loop that any registered strategy's signal function
 * can plug into. SAME_BAR_CLOSE fill model, matching this module's existing documented (non-
 * promotable) research fill model - see CLAUDE.md's "Research fill models" section.
 */
public final class SignalDrivenBacktest {

    public enum Signal { BUY, SELL, NEUTRAL }

    /** @param closes chronological closes up to and including the current bar (a growing window, never lookahead). */
    @FunctionalInterface
    public interface SignalFunction {
        Signal at(double[] closes, int index);
    }

    private static final double STOP_LOSS_PCT = 0.05; // matches tradingSafety.json's stopLossAssumptionPct

    private SignalDrivenBacktest() {
    }

    public record OpenPosition(int entryIndex, long entryTimestampMs, double entryPrice, double quantity) {
    }

    public static List<TradeRecord> run(String symbol, List<Bar> bars, double startingCash, double positionSizeFraction,
                                         int minWarmupBars, SignalFunction signalFn) {
        List<TradeRecord> trades = new ArrayList<>();
        if (bars.size() <= minWarmupBars) {
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

        for (int i = minWarmupBars; i < bars.size(); i++) {
            double[] window = Arrays.copyOfRange(closes, 0, i + 1);
            Signal signal = signalFn.at(window, i);
            Bar bar = bars.get(i);

            if (open == null && signal == Signal.BUY) {
                double notional = cash * positionSizeFraction;
                double quantity = Math.floor(notional / bar.close());
                if (quantity >= 1) {
                    double slipPct = Slippage.calculateDynamicSlippagePct(
                        Arrays.copyOfRange(highs, 0, i + 1), Arrays.copyOfRange(lows, 0, i + 1), window, bar.close(), quantity, bar.volume());
                    double fillPrice = bar.close() * (1 + slipPct);
                    open = new OpenPosition(i, bar.timestampMs(), fillPrice, quantity);
                }
            } else if (open != null) {
                boolean stopHit = bar.close() <= open.entryPrice() * (1 - STOP_LOSS_PCT);
                boolean signalReversed = signal == Signal.SELL;
                if (stopHit || signalReversed) {
                    double slipPct = Slippage.calculateDynamicSlippagePct(
                        Arrays.copyOfRange(highs, 0, i + 1), Arrays.copyOfRange(lows, 0, i + 1), window, bar.close(), open.quantity(), bar.volume());
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
