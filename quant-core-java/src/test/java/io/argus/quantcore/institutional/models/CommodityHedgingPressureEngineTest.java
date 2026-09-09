package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class CommodityHedgingPressureEngineTest {

    @Test
    void buysUpperHalfWithLowestHedgersHp_andSellsLowerHalfWithHighestHedgersHp() {
        List<CommodityHedgingPressureEngine.CommodityHedgingPressureReading> readings = List.of(
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("A", 0.30, 0.90), // upper half by spec HP (0.90), lowest hedgers HP among upper half
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("B", 0.70, 0.80), // upper half by spec HP (0.80)
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("C", 0.80, 0.20), // lower half by spec HP (0.20), highest hedgers HP among lower half
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("D", 0.40, 0.10)  // lower half by spec HP (0.10)
        );

        var result = CommodityHedgingPressureEngine.evaluate(readings, 0.5);

        assertThat(result).isNotNull();
        assertThat(result.buyList()).containsExactly("A");
        assertThat(result.sellList()).containsExactly("C");
    }

    @Test
    void returnsNullRatherThanFabricating_whenFewerThanFourCommoditiesSupplied() {
        List<CommodityHedgingPressureEngine.CommodityHedgingPressureReading> readings = List.of(
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("A", 0.30, 0.90),
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("B", 0.70, 0.80)
        );
        assertThat(CommodityHedgingPressureEngine.evaluate(readings, 0.2)).isNull();
    }

    @Test
    void returnsNull_whenQuantileFractionIsOutOfRange() {
        List<CommodityHedgingPressureEngine.CommodityHedgingPressureReading> readings = List.of(
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("A", 0.30, 0.90),
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("B", 0.70, 0.80),
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("C", 0.80, 0.20),
            new CommodityHedgingPressureEngine.CommodityHedgingPressureReading("D", 0.40, 0.10)
        );
        assertThat(CommodityHedgingPressureEngine.evaluate(readings, 0.0)).isNull();
        assertThat(CommodityHedgingPressureEngine.evaluate(readings, 0.6)).isNull();
    }
}
