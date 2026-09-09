package io.argus.quantcore.institutional.models;

/**
 * Variance swap payoff and realized variance - Kakushadze &amp; Serur, "151 Trading Strategies"
 * (2018), Section 7.6, Eq. 434-436. A variance swap avoids the near-continuous Delta-hedging a
 * straddle-based volatility trade requires: its payoff is directly proportional to the difference
 * between realized variance and a preset variance strike. Long (short) is a bet realized
 * volatility will exceed (fall short of) the strike.
 */
public final class VarianceSwapEngine {

    private VarianceSwapEngine() {
    }

    /**
     * Eq. 435-436: annualized realized variance from a log-return series. Note the paper's own
     * convention: the mean of R(t) is NOT subtracted (divisor is T, not T-1) - a real, deliberate
     * choice this class preserves rather than "fixing" to a mean-adjusted sample variance.
     *
     * @param closes chronological underlying prices.
     * @param annualizationFactor F, e.g. 252 for daily sampling.
     * @return null if fewer than 2 closes are supplied, or any close is not positive.
     */
    public static Double realizedVariance(double[] closes, double annualizationFactor) {
        if (closes == null || closes.length < 2) {
            return null;
        }
        int t = closes.length - 1;
        double sumSquaredReturns = 0;
        for (int i = 1; i < closes.length; i++) {
            if (closes[i - 1] <= 0 || closes[i] <= 0) {
                return null;
            }
            double r = Math.log(closes[i] / closes[i - 1]);
            sumSquaredReturns += r * r;
        }
        return annualizationFactor / t * sumSquaredReturns;
    }

    /** Eq. 434: payoff = varianceNotional * (realizedVariance - varianceStrike). */
    public static double payoff(double varianceNotional, double realizedVariance, double varianceStrike) {
        return varianceNotional * (realizedVariance - varianceStrike);
    }
}
