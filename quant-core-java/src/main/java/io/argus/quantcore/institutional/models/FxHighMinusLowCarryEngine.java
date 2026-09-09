package io.argus.quantcore.institutional.models;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Cross-sectional high-minus-low FX carry - Kakushadze &amp; Serur, "151 Trading Strategies" (2018),
 * Section 8.2.1. Ranks a basket of currencies by forward discount D(t,T) = s(t) - f(t,T) (log spot
 * minus log forward, Eq. 442) and builds a dollar-neutral zero-cost basket: long the top quantile
 * (most positive discount - buy forwards), short the bottom quantile (most negative discount - sell
 * forwards). Delegates the actual quantile-basket mechanics to CrossSectionalQuantileBasketEngine,
 * which several other strategies in this catalog also use for the identical "rank, cut, equal-weight
 * a zero-cost basket" pattern.
 */
public final class FxHighMinusLowCarryEngine {

    private FxHighMinusLowCarryEngine() {
    }

    public record CurrencyQuote(String currency, double spotRate, double forwardRate) {
    }

    /**
     * @param quotes per-currency spot/forward quotes.
     * @param quantileFraction fraction of the basket per side - the paper's own fn. 147 notes this
     *                         is not fixed at decile for FX ("a half, a third, etc."), so it is
     *                         caller-supplied, not defaulted.
     * @return null if fewer than 2 currencies with positive spot rates are supplied.
     */
    public static CrossSectionalQuantileBasketEngine.Result evaluate(Iterable<CurrencyQuote> quotes, double quantileFraction) {
        Map<String, Double> discountsByCurrency = new LinkedHashMap<>();
        for (CurrencyQuote q : quotes) {
            if (q.spotRate() <= 0 || q.forwardRate() <= 0) continue;
            double discount = Math.log(q.spotRate()) - Math.log(q.forwardRate());
            discountsByCurrency.put(q.currency(), discount);
        }
        return CrossSectionalQuantileBasketEngine.evaluate(discountsByCurrency, quantileFraction);
    }
}
