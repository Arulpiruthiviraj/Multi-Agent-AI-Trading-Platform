package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class CommodityRollYieldEngineTest {

    @Test
    void singleCommodity_readsBackwardation_whenFrontMonthExceedsSecondMonth() {
        var result = CommodityRollYieldEngine.evaluate(80.0, 78.0);
        assertThat(result).isNotNull();
        assertThat(result.phi()).isGreaterThan(1.0);
        assertThat(result.regime()).isEqualTo("BACKWARDATION");
        assertThat(result.signal()).isEqualTo("BUY");
    }

    @Test
    void singleCommodity_readsContango_whenFrontMonthIsBelowSecondMonth() {
        var result = CommodityRollYieldEngine.evaluate(78.0, 80.0);
        assertThat(result).isNotNull();
        assertThat(result.phi()).isLessThan(1.0);
        assertThat(result.regime()).isEqualTo("CONTANGO");
        assertThat(result.signal()).isEqualTo("SELL");
    }

    @Test
    void returnsNullRatherThanFabricating_whenEitherPriceIsNotPositive() {
        assertThat(CommodityRollYieldEngine.evaluate(0, 78.0)).isNull();
        assertThat(CommodityRollYieldEngine.evaluate(80.0, -1.0)).isNull();
    }

    @Test
    void crossSectional_buysHighestPhiAndSellsLowestPhi() {
        List<CommodityRollYieldEngine.CommodityFutures> basket = List.of(
            new CommodityRollYieldEngine.CommodityFutures("OIL", 80.0, 75.0),   // phi ~1.067, most backwardated
            new CommodityRollYieldEngine.CommodityFutures("GOLD", 100.0, 100.0), // phi = 1.0
            new CommodityRollYieldEngine.CommodityFutures("CORN", 4.0, 4.5)     // phi ~0.889, most contango
        );

        var result = CommodityRollYieldEngine.evaluateCrossSectional(basket, 0.4);

        assertThat(result).isNotNull();
        assertThat(result.longBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactly("OIL");
        assertThat(result.shortBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactly("CORN");
    }
}
