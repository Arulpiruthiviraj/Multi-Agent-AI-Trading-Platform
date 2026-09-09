package io.argus.quantcore.institutional.models;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Commodity roll yield - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 9.1. Phi =
 * P1/P2 (Eq. 454), the ratio of the front-month to second-month futures price, measures backwardation
 * (phi &gt; 1, long futures earn positive roll yield on average) versus contango (phi &lt; 1). Both a
 * single-commodity reading and a cross-sectional zero-cost basket (buy high-phi, sell low-phi,
 * delegating to CrossSectionalQuantileBasketEngine per the paper's own construction) are provided.
 */
public final class CommodityRollYieldEngine {

    private CommodityRollYieldEngine() {
    }

    public record Result(
        double phi,
        String regime, // BACKWARDATION (phi > 1) or CONTANGO (phi < 1)
        String signal  // BUY (backwardation), SELL (contango), NEUTRAL (phi == 1)
    ) {
    }

    public record CommodityFutures(String commodity, double frontMonthPrice, double secondMonthPrice) {
    }

    /** Single-commodity reading. Returns null if either price is not positive. */
    public static Result evaluate(double frontMonthPrice, double secondMonthPrice) {
        if (frontMonthPrice <= 0 || secondMonthPrice <= 0) {
            return null;
        }
        double phi = frontMonthPrice / secondMonthPrice;
        String regime = phi > 1 ? "BACKWARDATION" : phi < 1 ? "CONTANGO" : "FLAT";
        String signal = phi > 1 ? "BUY" : phi < 1 ? "SELL" : "NEUTRAL";
        return new Result(phi, regime, signal);
    }

    /** Cross-sectional zero-cost basket, buying high-phi (backwardation) and selling low-phi (contango) commodities. */
    public static CrossSectionalQuantileBasketEngine.Result evaluateCrossSectional(Iterable<CommodityFutures> basket, double quantileFraction) {
        Map<String, Double> phiByCommodity = new LinkedHashMap<>();
        for (CommodityFutures cf : basket) {
            if (cf.frontMonthPrice() <= 0 || cf.secondMonthPrice() <= 0) continue;
            phiByCommodity.put(cf.commodity(), cf.frontMonthPrice() / cf.secondMonthPrice());
        }
        return CrossSectionalQuantileBasketEngine.evaluate(phiByCommodity, quantileFraction);
    }
}
