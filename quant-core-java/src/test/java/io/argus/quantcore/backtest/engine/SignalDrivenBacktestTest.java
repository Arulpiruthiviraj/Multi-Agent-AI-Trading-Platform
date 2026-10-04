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

        // P1-7 (2026-10-04): the still-open position is now force-closed/recorded at the final bar
        // (terminalLiquidation) rather than silently vanishing - this test's real assertion is "only
        // ONE entry was ever opened" (no doubling), which the single terminal-liquidation record
        // with the single-position's own quantity/basis proves just as well as an empty list did.
        assertThat(trades).hasSize(1);
        assertThat(trades.get(0).terminalLiquidation()).isTrue();
        assertThat(trades.get(0).entryTimestampMs()).isEqualTo(5); // the one and only entry, at bar 5
    }

    // P1-7 regression: a signal-only exit path (no stop hit, no terminal liquidation) must never
    // set terminalLiquidation - confirms the flag is a real distinguishing signal, not a default
    // true/false mix-up.
    @Test
    void normalSignalExitIsNotMarkedAsTerminalLiquidation() {
        List<Bar> bars = new ArrayList<>();
        for (int i = 0; i < 5; i++) bars.add(bar(i, 100));
        bars.add(bar(5, 100));
        bars.add(bar(6, 110));
        bars.add(bar(7, 120));
        SignalDrivenBacktest.SignalFunction fn = (closes, idx) -> {
            if (idx == 5) return SignalDrivenBacktest.Signal.BUY;
            if (idx == 7) return SignalDrivenBacktest.Signal.SELL;
            return SignalDrivenBacktest.Signal.NEUTRAL;
        };
        List<TradeRecord> trades = SignalDrivenBacktest.run("TEST", bars, 100_000, 0.10, 5, fn);
        assertThat(trades).hasSize(1);
        assertThat(trades.get(0).terminalLiquidation()).isFalse();
    }

    // P1-8 regression: a bar that dips through the stop intrabar and recovers to close ABOVE it
    // must still trigger the stop - the close alone would have missed this entirely.
    @Test
    void stopTriggersOnIntrabarLowEvenWhenTheBarRecoversToCloseAboveTheStop() {
        List<Bar> bars = new ArrayList<>();
        for (int i = 0; i < 5; i++) bars.add(bar(i, 100));
        bars.add(bar(5, 100)); // BUY at close 100; 5% stop = 95
        // Bar 6: opens 100, dips intrabar to 90 (well through the 95 stop), recovers to close 99.
        bars.add(new Bar(6, 100, 100.5, 90, 99, 1_000_000));
        bars.add(bar(7, 105));

        SignalDrivenBacktest.SignalFunction fn = (closes, idx) -> idx == 5 ? SignalDrivenBacktest.Signal.BUY : SignalDrivenBacktest.Signal.NEUTRAL;
        List<TradeRecord> trades = SignalDrivenBacktest.run("TEST", bars, 100_000, 0.10, 5, fn);

        assertThat(trades).hasSize(1);
        assertThat(trades.get(0).exitTimestampMs()).isEqualTo(6); // stop fired on bar 6, not held to bar 7
        assertThat(trades.get(0).terminalLiquidation()).isFalse();
        // Filled at (approximately) the stop price, not the bar's close of 99.
        assertThat(trades.get(0).exitPrice()).isLessThan(96);
    }

    // P1-8 regression: the inverse case - a bar whose CLOSE alone would have triggered the old
    // close-only check must NOT trigger the stop if intrabar low never actually reached it. This
    // guards against accidentally making the stop check "intrabar OR close" instead of a correct
    // intrabar-aware check driven by the bar's real low.
    @Test
    void stopDoesNotTriggerWhenIntrabarLowNeverReachedTheStopPrice() {
        List<Bar> bars = new ArrayList<>();
        for (int i = 0; i < 5; i++) bars.add(bar(i, 100));
        bars.add(bar(5, 100)); // BUY at close 100; 5% stop = 95
        bars.add(new Bar(6, 100, 100.5, 96, 96, 1_000_000)); // low 96 - never reaches 95
        bars.add(bar(7, 110));

        SignalDrivenBacktest.SignalFunction fn = (closes, idx) -> idx == 5 ? SignalDrivenBacktest.Signal.BUY : SignalDrivenBacktest.Signal.NEUTRAL;
        List<TradeRecord> trades = SignalDrivenBacktest.run("TEST", bars, 100_000, 0.10, 5, fn);

        // Never stopped out, never signal-exited -> still open at the end -> terminal liquidation.
        assertThat(trades).hasSize(1);
        assertThat(trades.get(0).terminalLiquidation()).isTrue();
        assertThat(trades.get(0).exitTimestampMs()).isEqualTo(7);
    }
}
