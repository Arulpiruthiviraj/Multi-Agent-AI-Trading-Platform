package io.argus.quantcore.institutional.models;

/**
 * Risk-adjusted price momentum - the single-symbol scoring formula behind Kakushadze &amp; Serur,
 * "151 Trading Strategies" (2018), Section 3.1, itself grounded in Jegadeesh &amp; Titman,
 * "Returns to Buying Winners and Selling Losers," J. Finance 1993, and Asness, Moskowitz &amp;
 * Pedersen, "Value and Momentum Everywhere," J. Finance 2013. Distinct from
 * TimeSeriesMomentumEngine.java's simpler total-return-over-lookback measure: this is a
 * Sharpe-ratio-style score (mean periodic return over the formation window, divided by that same
 * window's own return volatility), and it explicitly separates a "skip period" (the most recent S
 * periods, conventionally 1 month) from the "formation period" (T periods before that, conventionally
 * 12 months) - the skip period exists because of a well-documented short-horizon reversal effect
 * that would otherwise contaminate a pure momentum signal (Jegadeesh, "Evidence of Predictable
 * Behavior of Security Returns," J. Finance 1990).
 *
 * This class computes the real, precise SCORE only - the paper's own strategy construction ("buy
 * the top decile by this score, short the bottom decile") is a cross-sectional portfolio operation
 * across many symbols, out of scope here by design (matches this session's own decision to defer
 * cross-sectional/portfolio infrastructure as separate, larger work).
 *
 * Periodicity-agnostic: the paper's own convention uses monthly bars, but nothing in the formula
 * requires that - callers may supply any periodic (e.g. weekly, monthly) closes series as long as
 * skipPeriods/formationPeriods are expressed in the same units.
 */
public final class RiskAdjustedMomentumEngine {

    private RiskAdjustedMomentumEngine() {
    }

    public record Result(
        double cumulativeReturn,      // P(S) / P(S+T) - 1, the formation-period total return
        double meanPeriodicReturn,    // mean of the T periodic returns within the formation window
        double periodicReturnStdDev,  // sample stddev of those same T periodic returns
        double riskAdjustedMomentum   // meanPeriodicReturn / periodicReturnStdDev - the paper's own headline score
    ) {
    }

    /**
     * @param closes            chronological periodic closes (oldest first); closes[closes.length-1]
     *                          is "now" (t=0 in the paper's own backward-counting convention).
     * @param skipPeriods       S - how many of the most recent periods to skip (paper's convention: 1 month).
     * @param formationPeriods  T - how many periods, immediately before the skip window, define the
     *                          formation period (paper's convention: 12 months).
     * @return null if there isn't enough history for both the skip and formation windows, or the
     *         formation-period return series has zero variance (a genuinely undefined risk-adjusted
     *         score, not fabricated as 0 or infinity).
     */
    public static Result evaluate(double[] closes, int skipPeriods, int formationPeriods) {
        int n = closes.length;
        if (skipPeriods < 0 || formationPeriods < 2 || n < skipPeriods + formationPeriods + 1) {
            return null;
        }
        int last = n - 1;

        double pAtS = closes[last - skipPeriods];
        double pAtSplusT = closes[last - skipPeriods - formationPeriods];
        if (pAtSplusT == 0) {
            return null;
        }
        double cumulativeReturn = pAtS / pAtSplusT - 1;

        // T periodic returns R(t) = P(t)/P(t+1) - 1, for t = S .. S+T-1 (the paper's own indexing).
        double[] periodicReturns = new double[formationPeriods];
        for (int t = skipPeriods; t < skipPeriods + formationPeriods; t++) {
            double pT = closes[last - t];
            double pTplus1 = closes[last - t - 1];
            if (pTplus1 == 0) {
                return null;
            }
            periodicReturns[t - skipPeriods] = pT / pTplus1 - 1;
        }

        double mean = 0;
        for (double r : periodicReturns) mean += r;
        mean /= formationPeriods;

        double sumSq = 0;
        for (double r : periodicReturns) sumSq += (r - mean) * (r - mean);
        double stdDev = Math.sqrt(sumSq / (formationPeriods - 1)); // sample stddev, matching the paper's own T-1 divisor

        if (stdDev == 0) {
            return null;
        }
        double riskAdjusted = mean / stdDev;

        return new Result(cumulativeReturn, mean, stdDev, riskAdjusted);
    }

    /** Paper's own conventional defaults: skip 1 month, 12-month formation window. */
    public static Result evaluate(double[] closes) {
        return evaluate(closes, 1, 12);
    }
}
