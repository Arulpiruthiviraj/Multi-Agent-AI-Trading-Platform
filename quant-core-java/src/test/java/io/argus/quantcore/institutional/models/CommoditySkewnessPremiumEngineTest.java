package io.argus.quantcore.institutional.models;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class CommoditySkewnessPremiumEngineTest {

    @Test
    void computeSkewness_isZero_forASymmetricReturnSeries() {
        // Symmetric around the mean -> third moment is exactly zero.
        double[] returns = {-0.02, -0.01, 0.0, 0.01, 0.02};
        assertThat(CommoditySkewnessPremiumEngine.computeSkewness(returns)).isCloseTo(0.0, within(1e-9));
    }

    @Test
    void computeSkewness_isNegative_forALeftSkewedSeries() {
        // A few large negative outliers, mostly small positive returns -> negative skew.
        double[] returns = {0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, -0.10, -0.08};
        assertThat(CommoditySkewnessPremiumEngine.computeSkewness(returns)).isLessThan(0.0);
    }

    @Test
    void computeSkewness_isPositive_forARightSkewedSeries() {
        double[] returns = {-0.01, -0.01, -0.01, -0.01, -0.01, -0.01, -0.01, 0.10, 0.08};
        assertThat(CommoditySkewnessPremiumEngine.computeSkewness(returns)).isGreaterThan(0.0);
    }

    @Test
    void buysTheMostNegativelySkewedCommodity_andSellsTheMostPositivelySkewed() {
        double[] negSkew = {0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, -0.10, -0.08};
        double[] flatSkew = {-0.02, -0.01, 0.0, 0.01, 0.02};
        double[] posSkew = {-0.01, -0.01, -0.01, -0.01, -0.01, -0.01, -0.01, 0.10, 0.08};

        List<CommoditySkewnessPremiumEngine.CommodityReturns> basket = List.of(
            new CommoditySkewnessPremiumEngine.CommodityReturns("NEG", negSkew),
            new CommoditySkewnessPremiumEngine.CommodityReturns("FLAT", flatSkew),
            new CommoditySkewnessPremiumEngine.CommodityReturns("POS", posSkew)
        );

        var result = CommoditySkewnessPremiumEngine.evaluate(basket, 0.4);

        assertThat(result).isNotNull();
        assertThat(result.longBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactly("NEG");
        assertThat(result.shortBasket()).extracting(CrossSectionalQuantileBasketEngine.Position::symbol)
            .containsExactly("POS");
    }

    @Test
    void skipsCommoditiesWithTooFewReturnsToComputeSkewness() {
        List<CommoditySkewnessPremiumEngine.CommodityReturns> basket = List.of(
            new CommoditySkewnessPremiumEngine.CommodityReturns("A", new double[]{0.01, 0.02, 0.03}),
            new CommoditySkewnessPremiumEngine.CommodityReturns("B", new double[]{0.01}), // too short, excluded
            new CommoditySkewnessPremiumEngine.CommodityReturns("C", new double[]{-0.01, -0.02, -0.03})
        );

        var result = CommoditySkewnessPremiumEngine.evaluate(basket, 0.5);
        assertThat(result).isNotNull();
        assertThat(result.longBasket()).hasSize(1);
        assertThat(result.shortBasket()).hasSize(1);
    }
}
