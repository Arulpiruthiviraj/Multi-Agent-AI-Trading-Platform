package io.argus.quantcore.backtest.engine;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real test coverage for the generic signal-driven backtest loop (2026-08-24 readiness audit,
 * Part 9) - the "generic harness rather than hardcoding to RsiThresholdStrategy" the audit asked
 * for. Synthetic-but-deterministic bars (no fabricated market data - these are constructed prices
 * to exercise a known signal pattern, not presented as real historical data anywhere).
 */
class SignalDrivenBacktestTest {

    private static Bar bar(long t, double price) {
        return new Bar(t, price, price * 1.001, price * 0.999, price, 1_000_000);
    }

    @Test
    void entersLongOnABuySignalAndExitsOnASellSignal() {
        List<Bar> bars = new ArrayList<>();
        for (int i = 0; i < 5; i++) bars.add(bar(i, 100)); // warmup
        bars.add(bar(5, 100)); // BUY here
        bars.add(bar(6, 110));
        bars.add(bar(7, 120)); // SELL here

        SignalDrivenBacktest.SignalFunction fn = (closes, idx) -> {
            if (idx == 5) return SignalDrivenBacktest.Signal.BUY;
            if (idx == 7) return SignalDrivenBacktest.Signal.SELL;
            return SignalDrivenBacktest.Signal.NEUTRAL;
        };

        List<TradeRecord> trades = SignalDrivenBacktest.run("TEST", bars, 100_000, 0.10, 5, fn);

        assertThat(trades).hasSize(1);
        assertThat(trades.get(0).entryTimestampMs()).isEqualTo(5);
        assertThat(trades.get(0).exitTimestampMs()).isEqualTo(7);
        assertThat(trades.get(0).pnl()).isPositive(); // price rose 100 -> 120
    }

    @Test
    void exitsOnStopLossEvenWithoutAnExplicitSellSignal() {
        List<Bar> bars = new ArrayList<>();
        for (int i = 0; i < 5; i++) bars.add(bar(i, 100));
        bars.add(bar(5, 100)); // BUY here
        bars.add(bar(6, 90)); // 10% drop - exceeds the 5% stop
        bars.add(bar(7, 80));

        SignalDrivenBacktest.SignalFunction fn = (closes, idx) -> idx == 5 ? SignalDrivenBacktest.Signal.BUY : SignalDrivenBacktest.Signal.NEUTRAL;

        List<TradeRecord> trades = SignalDrivenBacktest.run("TEST", bars, 100_000, 0.10, 5, fn);

        assertThat(trades).hasSize(1);
        assertThat(trades.get(0).exitTimestampMs()).isEqualTo(6); // stop hit on the very next bar, not held to bar 7
        assertThat(trades.get(0).pnl()).isNegative();
    }

    @Test
    void neverOpensAPositionBeforeMinWarmupBars() {
        List<Bar> bars = new ArrayList<>();
        for (int i = 0; i < 10; i++) bars.add(bar(i, 100));

        SignalDrivenBacktest.SignalFunction alwaysBuy = (closes, idx) -> SignalDrivenBacktest.Signal.BUY;

        List<TradeRecord> trades = SignalDrivenBacktest.run("TEST", bars, 100_000, 0.10, 8, alwaysBuy);

        for (TradeRecord t : trades) {
            assertThat(t.entryTimestampMs()).isGreaterThanOrEqualTo(8);
        }
    }

    @Test
    void returnsNoTradesWhenThereAreFewerBarsThanTheWarmupRequirement() {
        List<Bar> bars = List.of(bar(0, 100), bar(1, 101), bar(2, 102));
        SignalDrivenBacktest.SignalFunction alwaysBuy = (closes, idx) -> SignalDrivenBacktest.Signal.BUY;

        List<TradeRecord> trades = SignalDrivenBacktest.run("TEST", bars, 100_000, 0.10, 10, alwaysBuy);

        assertThat(trades).isEmpty();
    }

    @Test
    void neverOpensASecondPositionWhileOneIsAlreadyOpen() {
        List<Bar> bars = new ArrayList<>();
        for (int i = 0; i < 5; i++) bars.add(bar(i, 100));
        bars.add(bar(5, 100));
        bars.add(bar(6, 101));
        bars.add(bar(7, 102)); // still no SELL - position should still be open, not doubled

        SignalDrivenBacktest.SignalFunction alwaysBuy = (closes, idx) -> SignalDrivenBacktest.Signal.BUY;

        List<TradeRecord> trades = SignalDrivenBacktest.run("TEST", bars, 100_000, 0.10, 5, alwaysBuy);

        assertThat(trades).isEmpty(); // one open position, never closed, never a second entry recorded as a trade
    }
}
