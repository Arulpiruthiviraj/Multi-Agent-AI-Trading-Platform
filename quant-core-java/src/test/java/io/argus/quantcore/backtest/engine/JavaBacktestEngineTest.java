package io.argus.quantcore.backtest.engine;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class JavaBacktestEngineTest {

    private static List<Bar> dipAndRecoveryBars(double startPrice) {
        java.util.List<Bar> bars = new java.util.ArrayList<>();
        double price = startPrice;
        long ts = 0;
        for (int i = 0; i < 20; i++) {
            bars.add(new Bar(ts, price, price * 1.01, price * 0.99, price, 1000));
            ts += 86_400_000L;
        }
        for (int i = 0; i < 10; i++) {
            price -= 2.5;
            bars.add(new Bar(ts, price, price * 1.01, price * 0.99, price, 1000));
            ts += 86_400_000L;
        }
        for (int i = 0; i < 15; i++) {
            price += 2.5;
            bars.add(new Bar(ts, price, price * 1.01, price * 0.99, price, 1000));
            ts += 86_400_000L;
        }
        return bars;
    }

    @Test
    void runsMultipleSymbolsConcurrentlyAndAggregatesResults() throws InterruptedException {
        Map<String, List<Bar>> bySymbol = Map.of(
            "AAA", dipAndRecoveryBars(100),
            "BBB", dipAndRecoveryBars(200),
            "CCC", dipAndRecoveryBars(50)
        );

        JavaBacktestEngine engine = new JavaBacktestEngine();
        JavaBacktestEngine.RunResult result = engine.run(bySymbol, 100_000, 0.1);

        assertThat(result.bySymbol()).hasSize(3);
        assertThat(result.totalBarsProcessed()).isEqualTo(45L * 3);
        assertThat(result.durationNanos()).isGreaterThan(0);
        for (var entry : result.bySymbol().entrySet()) {
            assertThat(entry.getValue().trades()).isNotEmpty();
        }
    }

    @Test
    void handlesAnEmptySymbolMapWithoutError() throws InterruptedException {
        JavaBacktestEngine engine = new JavaBacktestEngine();
        JavaBacktestEngine.RunResult result = engine.run(Map.of(), 100_000, 0.1);
        assertThat(result.bySymbol()).isEmpty();
        assertThat(result.totalBarsProcessed()).isZero();
    }
}
