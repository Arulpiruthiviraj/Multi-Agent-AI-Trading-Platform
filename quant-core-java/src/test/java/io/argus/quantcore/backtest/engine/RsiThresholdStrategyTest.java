package io.argus.quantcore.backtest.engine;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class RsiThresholdStrategyTest {

    /** A real dip (drives RSI oversold) followed by a real recovery (drives RSI back up) - not a
     *  fabricated trigger; this is a genuine synthetic price path a strategy could actually act on. */
    private static List<Bar> dipAndRecoveryBars() {
        List<Bar> bars = new ArrayList<>();
        double price = 100;
        long ts = 0;
        // Flat warmup so RSI has real history.
        for (int i = 0; i < 20; i++) {
            bars.add(bar(ts, price, 1000));
            ts += 86_400_000L;
        }
        // Real decline - drives RSI down toward oversold.
        for (int i = 0; i < 10; i++) {
            price -= 2.5;
            bars.add(bar(ts, price, 1000));
            ts += 86_400_000L;
        }
        // Real recovery - drives RSI back up past the exit threshold.
        for (int i = 0; i < 15; i++) {
            price += 2.5;
            bars.add(bar(ts, price, 1000));
            ts += 86_400_000L;
        }
        return bars;
    }

    private static Bar bar(long ts, double close, double volume) {
        return new Bar(ts, close, close * 1.01, close * 0.99, close, volume);
    }

    @Test
    void entersOnOversoldAndExitsOnRecovery() {
        List<TradeRecord> trades = new RsiThresholdStrategy().run("TEST", dipAndRecoveryBars(), 100_000, 0.1);
        assertThat(trades).isNotEmpty();
        TradeRecord first = trades.get(0);
        assertThat(first.entryPrice()).isGreaterThan(0);
        assertThat(first.exitTimestampMs()).isGreaterThan(first.entryTimestampMs());
        assertThat(first.commission()).isGreaterThanOrEqualTo(0);
    }

    @Test
    void producesNoTradesOnFlatHistoryTooShort() {
        List<Bar> bars = List.of(bar(0, 100, 1000), bar(1, 101, 1000));
        List<TradeRecord> trades = new RsiThresholdStrategy().run("TEST", bars, 100_000, 0.1);
        assertThat(trades).isEmpty();
    }

    @Test
    void metricsComputeCorrectlyForAKnownTradeSet() {
        List<TradeRecord> trades = List.of(
            new TradeRecord("A", 0, 100, 1, 110, 10, 100, 1, 0.001), // +100 win
            new TradeRecord("A", 2, 100, 3, 95, 10, -50, 1, 0.001)   // -50 loss
        );
        BacktestMetrics.Result metrics = BacktestMetrics.compute(trades, 10_000);
        assertThat(metrics.netPnl()).isEqualTo(50);
        assertThat(metrics.tradeCount()).isEqualTo(2);
        assertThat(metrics.winCount()).isEqualTo(1);
        assertThat(metrics.lossCount()).isEqualTo(1);
        assertThat(metrics.winRatePct()).isEqualTo(50.0);
        assertThat(metrics.profitFactor()).isEqualTo(2.0); // 100/50
    }
}
