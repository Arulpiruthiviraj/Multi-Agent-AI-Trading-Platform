package io.argus.quantcore.institutional.models;

/**
 * Crypto ANN input-layer feature primitives - Kakushadze &amp; Serur, "151 Trading Strategies"
 * (2018), Section 18.2, Eq. 521-529, citing Nakano, Takahashi &amp; Takahashi, "Bitcoin technical
 * trading with artificial neural network," Physica A 2018. This class implements ONLY the
 * deterministic feature-engineering math the paper specifies (normalized return, EMA, EMSD, and
 * a sum-based RSI variant, all over a caller-chosen trailing window) - it deliberately stops short
 * of the trainable artificial neural network / softmax classifier itself (Eq. 530-537), which
 * requires real weight training (stochastic gradient descent over cross-entropy loss, Eq. 536) and
 * model persistence, a materially larger undertaking than a pure evaluate() function and out of
 * scope for this pass.
 *
 * <p>Indexing note: the paper's own convention counts time backward from "now" (t=1 is most
 * recent), so its formulas describe windows that are, in real chronological terms, ordinary
 * TRAILING historical windows ending just before the point being scored - nothing here looks into
 * the future. This class uses this codebase's standard forward-chronological array convention
 * (closes[0] oldest, closes[length-1] most recent) instead, which is a pure indexing adaptation, not
 * a formula change.
 *
 * <p>Deliberately NOT reusing RollingStatistics.zScore for the normalized-return computation: that
 * utility's window INCLUDES the point being scored (real, existing behavior - see its own
 * rollingMean/rollingStdDev, which take the trailing N values inclusive of the last one), while
 * Eq. 522-525 here explicitly EXCLUDES the current return from its own mean/stddev window
 * (t'=t+1..t+T1, all strictly older than t) - a genuinely different, not interchangeable,
 * windowing convention.
 */
public final class CryptoReturnFeatureEngine {

    private CryptoReturnFeatureEngine() {
    }

    /** Eq. 521-style simple periodic return: r[i] = closes[i+1]/closes[i] - 1, for i = 0..n-2. */
    public static double[] computeReturns(double[] closes) {
        int n = closes.length;
        if (n < 2) {
            return new double[0];
        }
        double[] returns = new double[n - 1];
        for (int i = 0; i < n - 1; i++) {
            if (closes[i] == 0) {
                return null;
            }
            returns[i] = closes[i + 1] / closes[i] - 1;
        }
        return returns;
    }

    /**
     * Eq. 522-525: normalized (demeaned, vol-scaled) return at {@code index}, using the {@code
     * window} returns immediately PRECEDING {@code index} (excluding returns[index] itself) for
     * the mean and sample stddev.
     *
     * @return null if there isn't a full window of history before {@code index}, or the window's
     *         stddev is exactly zero (a genuinely undefined normalization, not fabricated).
     */
    public static Double computeNormalizedReturn(double[] returns, int index, int window) {
        if (window < 2 || index < window || index >= returns.length) {
            return null;
        }
        double mean = 0;
        for (int i = index - window; i < index; i++) mean += returns[i];
        mean /= window;

        double sumSq = 0;
        for (int i = index - window; i < index; i++) {
            double d = returns[i] - mean;
            sumSq += d * d;
        }
        double stdDev = Math.sqrt(sumSq / window);
        if (stdDev == 0) {
            return null;
        }
        return (returns[index] - mean) / stdDev;
    }

    /**
     * Eq. 526: exponential moving average over the {@code tau} returns immediately preceding
     * {@code index} (returns[index] itself is not included, matching the paper's own t'=t+1..t+tau
     * range being strictly older than t). The return closest to {@code index} gets the highest
     * weight (lambda^0); the furthest back in the window gets the lowest (lambda^(tau-1)).
     *
     * @return null if there isn't a full window of history, or lambda is not in (0, 1).
     */
    public static Double computeEma(double[] returns, int index, double lambda, int tau) {
        if (tau < 1 || index < tau || index > returns.length || lambda <= 0 || lambda >= 1) {
            return null;
        }
        double weightedSum = 0;
        double weightTotal = 0;
        for (int k = 0; k < tau; k++) {
            double weight = Math.pow(lambda, k);
            weightedSum += weight * returns[index - 1 - k];
            weightTotal += weight;
        }
        return weightedSum / weightTotal;
    }

    /**
     * Eq. 527: exponential moving standard deviation over the same window/weighting as {@link
     * #computeEma}, measuring dispersion around that EMA (not around the simple mean).
     *
     * @return null under the same conditions as {@link #computeEma}.
     */
    public static Double computeEmsd(double[] returns, int index, double lambda, int tau) {
        Double ema = computeEma(returns, index, lambda, tau);
        if (ema == null) {
            return null;
        }
        double weightedSumSq = 0;
        double weightTotal = 0;
        for (int k = 0; k < tau; k++) {
            double weight = Math.pow(lambda, k);
            double d = returns[index - 1 - k] - ema;
            weightedSumSq += weight * d * d;
            weightTotal += weight;
        }
        return Math.sqrt(weightedSumSq / weightTotal);
    }

    /**
     * Eq. 528-529: sum-based RSI variant on a [0,1] scale (distinct from the classic Wilder
     * average-based RSI elsewhere in this codebase, which is on a [0,100] scale) - ratio of the
     * sum of positive returns to the sum of absolute returns over the {@code tau} returns
     * immediately preceding {@code index}. The paper's own convention (fn. 222): &gt;0.7
     * overbought, &lt;0.3 oversold.
     *
     * @return null if there isn't a full window, or every return in the window is exactly zero
     *         (both sums zero - a genuinely undefined ratio, not fabricated as 0.5).
     */
    public static Double computeRsi(double[] returns, int index, int tau) {
        if (tau < 1 || index < tau || index > returns.length) {
            return null;
        }
        double positiveSum = 0;
        double negativeSum = 0;
        for (int k = 0; k < tau; k++) {
            double r = returns[index - 1 - k];
            if (r > 0) positiveSum += r;
            else negativeSum += -r;
        }
        double denominator = positiveSum + negativeSum;
        if (denominator == 0) {
            return null;
        }
        return positiveSum / denominator;
    }

    /** Footnote 224's own parameter-reduction convention: lambda = (tau-1)/(tau+1). */
    public static double lambdaFromTau(int tau) {
        return (tau - 1.0) / (tau + 1.0);
    }
}
