package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class CommodityValueEngineTest {

    @Test
    void buysTheCheapestCommodity_andSellsTheMostExpensive() {
        // v = P5/P0. A commodity whose price FELL over 5 years (P0 < P5) has v > 1 - it is
        // genuinely "cheap" relative to its own history now. A commodity whose price ROSE a lot
        // has v < 1 - "expensive." Top tercile by v (highest v, cheapest) is long; bottom (lowest
        // v, most expensive) is short.
        List<CommodityValueEngine.CommoditySpotHistory> basket = List.of(
            new CommodityValueEngine.CommoditySpotHistory("FELL", 150.0, 100.0), // v = 1.5, price fell -> cheap
            new CommodityValueEngine.CommoditySpotHistory("FLAT", 100.0, 100.0), // v = 1.0
            new CommodityValueEngine.CommoditySpotHistory("ROSE", 50.0, 150.0)   // v ~0.333, price tripled -> expensive
        );

        var result = CommodityValueEngine.evaluate(basket, 0.4);

        assertThat(result).isNotNull();
        assertThat(result.longBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactly("FELL");
        assertThat(result.shortBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactly("ROSE");
    }

    @Test
    void skipsNonPositivePrices() {
        List<CommodityValueEngine.CommoditySpotHistory> basket = List.of(
            new CommodityValueEngine.CommoditySpotHistory("A", 100.0, 100.0),
            new CommodityValueEngine.CommoditySpotHistory("B", 0.0, 100.0), // invalid
            new CommodityValueEngine.CommoditySpotHistory("C", 100.0, 200.0)
        );

        var result = CommodityValueEngine.evaluate(basket, 0.5);
        assertThat(result).isNotNull();
        assertThat(result.longBasket()).hasSize(1);
        assertThat(result.shortBasket()).hasSize(1);
    }

    @Test
    void returnsNull_whenFewerThanTwoValidCommoditiesRemain() {
        List<CommodityValueEngine.CommoditySpotHistory> basket = List.of(
            new CommodityValueEngine.CommoditySpotHistory("A", 100.0, 100.0)
        );
        assertThat(CommodityValueEngine.evaluate(basket, 0.4)).isNull();
    }
}
