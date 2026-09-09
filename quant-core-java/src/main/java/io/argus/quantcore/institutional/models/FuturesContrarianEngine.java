package io.argus.quantcore.institutional.models;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Futures contrarian (cross-sectional mean-reversion) - Kakushadze &amp; Serur, "151 Trading
 * Strategies" (2018), Section 10.3, citing Wang &amp; Yu, "Do Trend and Contrarian Trading Strategies
 * Work in the Commodity Futures Markets?" 2004. Market index return Rm = mean(Ri) (Eq. 469); raw
 * weight wi = -gamma * (Ri - Rm), i.e. buy losers vs. the index, sell winners, automatically
 * dollar-neutral by construction (sum of demeaned returns is zero); gamma is fixed by the
 * normalization sum|wi| = 1 (Eq. 470-471). Distinct from every other "contrarian" engine in this
 * codebase (which operate on a single symbol's own history): this is the cross-sectional index-
 * relative construction. Volatility suppression (1/sigma_i, mitigating overinvestment in volatile
 * futures per the paper's own note) is optional and caller-controlled via inverseVolatilityWeighting.
 */
public final class FuturesContrarianEngine {

    private FuturesContrarianEngine() {
    }

    public record FuturesReturn(String contract, double weeklyReturn, double historicalVolatility) {
    }

    public record Position(String contract, double weight) {
    }

    public record Result(double marketIndexReturn, Map<String, Double> weights) {
    }

    /**
     * @param returns per-contract weekly returns (and, if inverseVolatilityWeighting is true,
     *                each contract's own historical volatility - must be positive for every
     *                contract in that case, or the whole result is null rather than silently
     *                skipping volatility suppression for some contracts).
     * @param inverseVolatilityWeighting suppress raw weights by 1/sigma_i before normalizing,
     *                per the paper's own mitigation for overinvesting in volatile futures.
     * @return null if fewer than 2 contracts are supplied, or (with volatility weighting on) any
     *         contract has non-positive volatility.
     */
    public static Result evaluate(Iterable<FuturesReturn> returns, boolean inverseVolatilityWeighting) {
        java.util.List<FuturesReturn> list = new java.util.ArrayList<>();
        for (FuturesReturn r : returns) list.add(r);
        int n = list.size();
        if (n < 2) {
            return null;
        }

        double marketIndex = 0;
        for (FuturesReturn r : list) marketIndex += r.weeklyReturn();
        marketIndex /= n;

        double[] rawWeights = new double[n];
        for (int i = 0; i < n; i++) {
            FuturesReturn r = list.get(i);
            double w = -(r.weeklyReturn() - marketIndex);
            if (inverseVolatilityWeighting) {
                if (r.historicalVolatility() <= 0) {
                    return null;
                }
                w /= r.historicalVolatility();
            }
            rawWeights[i] = w;
        }

        double sumAbs = 0;
        for (double w : rawWeights) sumAbs += Math.abs(w);
        if (sumAbs == 0) {
            return null;
        }

        Map<String, Double> weights = new LinkedHashMap<>();
        for (int i = 0; i < n; i++) {
            weights.put(list.get(i).contract(), rawWeights[i] / sumAbs);
        }
        return new Result(marketIndex, weights);
    }
}
