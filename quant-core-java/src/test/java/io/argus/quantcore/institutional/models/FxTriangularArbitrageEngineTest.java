package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class FxTriangularArbitrageEngineTest {

    @Test
    void detectsArbitrage_whenTheChainProductExceedsOne() {
        // bidAB * bidBC * (1/askCA) > 1
        var result = FxTriangularArbitrageEngine.evaluate(1.10, 1.20, 0.70, 1.0, 1.0, 1.0);

        assertThat(result).isNotNull();
        assertThat(result.chainAtoBtoCtoA()).isGreaterThan(1.0);
        assertThat(result.arbitrageAvailable()).isTrue();
        assertThat(result.direction()).isEqualTo("A_B_C_A");
    }

    @Test
    void reportsNoArbitrage_whenBothChainsAreAtOrBelowOne() {
        var result = FxTriangularArbitrageEngine.evaluate(1.0, 1.0, 1.0, 1.0, 1.0, 1.0);

        assertThat(result).isNotNull();
        assertThat(result.arbitrageAvailable()).isFalse();
        assertThat(result.direction()).isEqualTo("NONE");
    }

    @Test
    void detectsArbitrageInTheReverseChain_whenOnlyThatChainExceedsOne() {
        var result = FxTriangularArbitrageEngine.evaluate(1.0, 1.0, 1.0, 1.10, 1.20, 0.70);

        assertThat(result).isNotNull();
        assertThat(result.chainAtoCtoBtoA()).isGreaterThan(1.0);
        assertThat(result.arbitrageAvailable()).isTrue();
        assertThat(result.direction()).isEqualTo("A_C_B_A");
    }

    @Test
    void returnsNullRatherThanFabricating_whenAnyRateIsNotPositive() {
        assertThat(FxTriangularArbitrageEngine.evaluate(0, 1.0, 1.0, 1.0, 1.0, 1.0)).isNull();
        assertThat(FxTriangularArbitrageEngine.evaluate(1.0, 1.0, -1.0, 1.0, 1.0, 1.0)).isNull();
    }
}
