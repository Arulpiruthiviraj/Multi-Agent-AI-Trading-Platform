package io.argus.quantcore.institutional.models;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Commodity skewness premium - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 9.5,
 * citing Fernandez-Perez et al., "The Skewness of Commodity Futures Returns," J. Banking &amp; Finance
 * 2018. Empirically, historical return skewness is negatively correlated with future expected
 * returns; skewness S_i (Eq. 456-458, standard sample skewness with the paper's own N-1 divisor
 * convention for the variance term) is computed per commodity, and a zero-cost basket buys the
 * bottom quintile (most negatively skewed) and sells the top quintile (most positively skewed) -
 * again the opposite ranking direction from CrossSectionalQuantileBasketEngine's "higher score =
 * long side" convention, so -skewness is the score fed in.
 */
public final class CommoditySkewnessPremiumEngine {

    private CommoditySkewnessPremiumEngine() {
    }

    public record CommodityReturns(String commodity, double[] historicalReturns) {
    }

    /** Standard sample skewness: (1/T) sum[(R-Rbar)^3] / [(1/(T-1)) sum[(R-Rbar)^2]]^(3/2), matching Eq. 456-458. */
    public static double computeSkewness(double[] returns) {
        int t = returns.length;
        double mean = 0;
        for (double r : returns) mean += r;
        mean /= t;

        double sumCubed = 0, sumSquared = 0;
        for (double r : returns) {
            double d = r - mean;
            sumCubed += d * d * d;
            sumSquared += d * d;
        }
        double thirdMoment = sumCubed / t;
        double variance = sumSquared / (t - 1);
        double stdDevCubed = Math.pow(variance, 1.5);
        return thirdMoment / stdDevCubed;
    }

    /**
     * @param basket per-commodity historical return series (at least 3 points each - skewness needs
     *               a real third moment, and the paper's own variance divisor is T-1).
     * @param quantileFraction fraction per side; paper's own worked example uses quintiles (0.2).
     * @return null if fewer than 2 commodities have enough history to compute a defined skewness.
     */
    public static CrossSectionalQuantileBasketEngine.Result evaluate(Iterable<CommodityReturns> basket, double quantileFraction) {
        Map<String, Double> inverseSkewnessByCommodity = new LinkedHashMap<>();
        for (CommodityReturns cr : basket) {
            double[] returns = cr.historicalReturns();
            if (returns == null || returns.length < 3) continue;
            double skewness = computeSkewness(returns);
            if (Double.isNaN(skewness) || Double.isInfinite(skewness)) continue;
            inverseSkewnessByCommodity.put(cr.commodity(), -skewness); // most negative skew -> highest score -> long side
        }
        return CrossSectionalQuantileBasketEngine.evaluate(inverseSkewnessByCommodity, quantileFraction);
    }
}
