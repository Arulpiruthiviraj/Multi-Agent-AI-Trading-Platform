package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class RelativeStrengthVsBenchmarkEngineTest {

    @Test
    void signalsBuyWhenTheStockOutperformsTheBenchmark() {
        double[] stock = new double[30];
        double[] benchmark = new double[30];
        for (int i = 0; i < 30; i++) {
            stock[i] = 100 + i * 2.0;   // +2/day
            benchmark[i] = 100 + i * 0.5; // +0.5/day - stock clearly outperforming
        }

        var result = RelativeStrengthVsBenchmarkEngine.evaluate(stock, benchmark, 20);

        assertThat(result).isNotNull();
        assertThat(result.relativeStrength()).isGreaterThan(0);
        assertThat(result.signal()).isEqualTo("BUY");
    }

    @Test
    void signalsSellWhenTheStockUnderperformsTheBenchmark() {
        double[] stock = new double[30];
        double[] benchmark = new double[30];
        for (int i = 0; i < 30; i++) {
            stock[i] = 100 + i * 0.2;
            benchmark[i] = 100 + i * 2.0;
        }

        var result = RelativeStrengthVsBenchmarkEngine.evaluate(stock, benchmark, 20);

        assertThat(result.relativeStrength()).isLessThan(0);
        assertThat(result.signal()).isEqualTo("SELL");
    }

    @Test
    void returnsNullRatherThanFabricatingWhenThereIsNotEnoughHistory() {
        double[] stock = { 100, 101 };
        double[] benchmark = { 100, 101 };
        assertThat(RelativeStrengthVsBenchmarkEngine.evaluate(stock, benchmark, 20)).isNull();
    }
}
