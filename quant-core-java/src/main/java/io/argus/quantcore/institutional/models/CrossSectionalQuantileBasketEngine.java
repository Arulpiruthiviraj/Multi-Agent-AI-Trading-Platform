package io.argus.quantcore.institutional.models;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * Generic cross-sectional zero-cost quantile basket construction: given a per-symbol score, buy
 * (equal-weight) the top quantile and sell (equal-weight) the bottom quantile. This is the shared
 * mechanism behind several distinct Kakushadze &amp; Serur, "151 Trading Strategies" (2018) strategies
 * that differ only in what score they rank by - FX high-minus-low carry (Sec 8.2.1, forward discount),
 * commodity roll yields (Sec 9.1, front/second-month futures ratio), commodity value (Sec 9.4,
 * 5-year price ratio), and commodity skewness premium (Sec 9.5, historical return skewness). Each of
 * those strategies keeps its own thin named wrapper for registration/discoverability; this class is
 * the one real computation they all delegate to, rather than four independent (and inevitably
 * slightly-different) reimplementations of "sort, cut, equal-weight."
 *
 * Distinct from CrossSectionalRankingEngine.java (which ranks a *fixed* decile by trailing return
 * specifically) and StatArbEngine (pairs/cointegration) - this is a general-purpose, score-agnostic,
 * caller-chosen-quantile basket builder.
 */
public final class CrossSectionalQuantileBasketEngine {

    private CrossSectionalQuantileBasketEngine() {
    }

    public record Position(String symbol, double score, double weight) {
    }

    public record Result(List<Position> longBasket, List<Position> shortBasket) {
    }

    /**
     * @param scoresBySymbol per-symbol score to rank by (higher = more attractive for the long
     *                       side, matching every cited strategy's own convention).
     * @param quantileFraction fraction of the basket to take on each side, e.g. 0.1 for deciles,
     *                       1.0/3 for terciles, 0.2 for quintiles - the paper itself notes this
     *                       varies by strategy and by how many names are available (fn. 147: "this
     *                       quantile can be a half, a third, etc."), so it is never defaulted here.
     * @return null if fewer than 2 symbols are supplied or quantileFraction is out of (0, 0.5].
     *         Equal weights within each side sum to 1.0 in magnitude (i.e. a true zero-cost,
     *         unit-gross-exposure basket) - the same "buy the top, sell the bottom, equal-weighted
     *         within each side" convention every cited strategy states.
     */
    public static Result evaluate(Map<String, Double> scoresBySymbol, double quantileFraction) {
        if (scoresBySymbol == null || scoresBySymbol.size() < 2 || quantileFraction <= 0 || quantileFraction > 0.5) {
            return null;
        }
        List<Map.Entry<String, Double>> sorted = new ArrayList<>(scoresBySymbol.entrySet());
        sorted.sort(Comparator.<Map.Entry<String, Double>>comparingDouble(Map.Entry::getValue).reversed());

        int total = sorted.size();
        int basketSize = Math.max(1, (int) Math.round(total * quantileFraction));
        basketSize = Math.min(basketSize, total / 2);
        if (basketSize < 1) {
            return null;
        }

        double weightEach = 1.0 / basketSize;
        List<Position> longBasket = new ArrayList<>(basketSize);
        List<Position> shortBasket = new ArrayList<>(basketSize);
        for (int i = 0; i < basketSize; i++) {
            Map.Entry<String, Double> longEntry = sorted.get(i);
            longBasket.add(new Position(longEntry.getKey(), longEntry.getValue(), weightEach));

            Map.Entry<String, Double> shortEntry = sorted.get(total - 1 - i);
            shortBasket.add(new Position(shortEntry.getKey(), shortEntry.getValue(), -weightEach));
        }

        return new Result(longBasket, shortBasket);
    }
}
