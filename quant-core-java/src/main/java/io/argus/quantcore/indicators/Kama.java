package io.argus.quantcore.indicators;

/**
 * Kaufman Adaptive Moving Average (KAMA / AMA-with-EMA), Perry J. Kaufman's public-domain
 * indicator (Kaufman, "Smarter Trading", 1995; "Trading Systems and Methods", 2013). Formula
 * transcribed from Jun Lu, "Exploring Classic Quantitative Strategies" (arXiv:2202.11309, 2022),
 * Eq. (2.5)-(2.7):
 *   fastSC = 2/(fastPeriod+1), slowSC = 2/(slowPeriod+1)
 *   SSC[i] = |ER[i]| * (fastSC - slowSC) + slowSC        (scaled smoothing constant)
 *   KAMA[i] = KAMA[i-1] + SSC[i]^2 * (price[i] - KAMA[i-1])
 * where ER is Kaufman's Efficiency Ratio (see EffectiveRatio.java) over the adaptive window.
 * Squaring SSC is Kaufman's own recommendation for a more efficient influence of the smoothing
 * constant on the averaging period (Lu, 2022, p.10) - not an invented refinement.
 */
public final class Kama {

    private Kama() {
    }

    /**
     * @param prices      chronological input series (oldest first).
     * @param adaWin      Kaufman's efficiency-ratio window (paper's example: 10).
     * @param fastPeriod  the short/fast EMA-equivalent period (paper's example: 2).
     * @param slowPeriod  the long/slow EMA-equivalent period (paper's example: 30).
     * @return full KAMA series (same length as {@code prices}); {@code prices[0]} seeds the
     *         series (matching MovingAverages.ema's own first-price-seeded convention for
     *         consistency), and every index before {@code adaWin} history exists carries forward
     *         the seed via a slowSC-only step (ER treated as 0 - the honest "not enough history to
     *         judge trend efficiency yet" case, never a fabricated ratio).
     */
    public static double[] calculate(double[] prices, int adaWin, int fastPeriod, int slowPeriod) {
        if (prices == null || prices.length == 0) {
            return new double[0];
        }
        double fastSC = 2.0 / (fastPeriod + 1);
        double slowSC = 2.0 / (slowPeriod + 1);
        double diffSC = fastSC - slowSC;

        double[] kama = new double[prices.length];
        kama[0] = prices[0];
        for (int i = 1; i < prices.length; i++) {
            double er = EffectiveRatio.calculate(java.util.Arrays.copyOfRange(prices, 0, i + 1), adaWin);
            double erAbs = Double.isNaN(er) ? 0 : Math.abs(er);
            double ssc = erAbs * diffSC + slowSC;
            kama[i] = kama[i - 1] + (ssc * ssc) * (prices[i] - kama[i - 1]);
        }
        return kama;
    }

    /** Paper's own worked example defaults (Lu 2022, Figure 3 caption): AdaWin=12, fast=5, slow=50. */
    public static double[] calculate(double[] prices) {
        return calculate(prices, 12, 5, 50);
    }
}
