package io.argus.quantcore.institutional.models;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Commodity value - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 9.4, citing
 * Asness, Moskowitz &amp; Pedersen, "Value and Momentum Everywhere," J. Finance 2013. v = P5/P0
 * (Eq. 455), the ratio of the spot price 5 years ago to the current spot price. A HIGH v means
 * P0 &lt; P5 - the price has FALLEN over 5 years, so the commodity is "cheap" relative to its own
 * history; a LOW v means the price has risen a lot, so it is "expensive." The paper's own
 * construction: buy the top tercile by v (cheap), sell the bottom tercile (expensive) - this is
 * the SAME direction as CrossSectionalQuantileBasketEngine's "higher score = long side"
 * convention, so v itself is fed in directly, with no inversion.
 */
public final class CommodityValueEngine {

    private CommodityValueEngine() {
    }

    public record CommoditySpotHistory(String commodity, double spotPriceFiveYearsAgo, double currentSpotPrice) {
    }

    /**
     * @param basket per-commodity 5-years-ago and current spot prices.
     * @param quantileFraction fraction per side; paper's own worked example uses terciles (1.0/3).
     * @return null if fewer than 2 valid commodities are supplied.
     */
    public static CrossSectionalQuantileBasketEngine.Result evaluate(Iterable<CommoditySpotHistory> basket, double quantileFraction) {
        Map<String, Double> valueByCommodity = new LinkedHashMap<>();
        for (CommoditySpotHistory h : basket) {
            if (h.spotPriceFiveYearsAgo() <= 0 || h.currentSpotPrice() <= 0) continue;
            double v = h.spotPriceFiveYearsAgo() / h.currentSpotPrice();
            valueByCommodity.put(h.commodity(), v); // high v (price fell) = cheap -> long side, matches basket engine's convention directly
        }
        return CrossSectionalQuantileBasketEngine.evaluate(valueByCommodity, quantileFraction);
    }
}
