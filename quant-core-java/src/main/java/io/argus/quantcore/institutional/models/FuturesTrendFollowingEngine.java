package io.argus.quantcore.institutional.models;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Futures trend following (time-series momentum, cross-sectionally weighted) - Kakushadze &amp;
 * Serur, "151 Trading Strategies" (2018), Section 10.4, citing Moskowitz, Ooi &amp; Pedersen, "Time
 * Series Momentum," J. Financial Economics 2012. Raw weight w_i = gamma * eta_i / sigma_i, where
 * eta_i = sign(R_i) (Eq. 474-475), normalized by sum|w_i| = 1 (Eq. 476). The paper notes this raw
 * construction is NOT dollar-neutral; an optional demeaned variant (Eq. 477, dollarNeutral=true)
 * subtracts the cross-sectional mean of eta_i/sigma_i before normalizing. Distinct from
 * FuturesContrarianEngine (which weights by the MAGNITUDE of the return spread vs. the index, in
 * the opposite direction): this weights by the SIGN of each contract's own return, in the same
 * direction.
 */
public final class FuturesTrendFollowingEngine {

    private FuturesTrendFollowingEngine() {
    }

    public record FuturesReturn(String contract, double periodReturn, double historicalVolatility) {
    }

    public record Result(Map<String, Double> weights) {
    }

    /**
     * @param returns      per-contract period return and historical volatility (must be positive
     *                     for every contract - a zero/negative volatility makes eta_i/sigma_i
     *                     undefined, not fabricated as some large number).
     * @param dollarNeutral apply the Eq. 477 demeaning so the basket is dollar-neutral; the raw
     *                      Eq. 474-476 construction is NOT dollar-neutral by itself, per the
     *                      paper's own note.
     * @return null if fewer than 2 contracts are supplied, any volatility is non-positive, or
     *         every raw weight is exactly zero (e.g. every return is exactly flat).
     */
    public static Result evaluate(Iterable<FuturesReturn> returns, boolean dollarNeutral) {
        List<FuturesReturn> list = new ArrayList<>();
        for (FuturesReturn r : returns) list.add(r);
        int n = list.size();
        if (n < 2) {
            return null;
        }

        double[] rawWeights = new double[n];
        for (int i = 0; i < n; i++) {
            FuturesReturn r = list.get(i);
            if (r.historicalVolatility() <= 0) {
                return null;
            }
            double eta = Math.signum(r.periodReturn());
            rawWeights[i] = eta / r.historicalVolatility();
        }

        if (dollarNeutral) {
            double mean = 0;
            for (double w : rawWeights) mean += w;
            mean /= n;
            for (int i = 0; i < n; i++) rawWeights[i] -= mean;
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
        return new Result(weights);
    }
}
