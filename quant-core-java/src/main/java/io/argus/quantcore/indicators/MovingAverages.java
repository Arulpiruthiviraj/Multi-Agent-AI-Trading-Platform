package io.argus.quantcore.indicators;

/**
 * SMA/EMA, ported byte-for-byte from the live TypeScript reference implementations so parity
 * tests can assert exact (epsilon-bounded) agreement:
 *   - {@link #sma} mirrors {@code calcSMA} in src/server/services/technicalSignal.ts.
 *   - {@link #ema} mirrors the private {@code calcEMA} helper in src/server/engines/MACDEngine.ts
 *     as of its 2026-09-22 seeding fix: indices {@code [0, warmupLen)} are seeded with the SMA
 *     of the first {@code warmupLen = min(period, length)} prices (backfilled), then the
 *     recursive EMA runs from {@code warmupLen} onward. The old first-price seed this method
 *     used to carry was a real, documented TS defect (MACDEngine.ts's own comment: "a real
 *     defect found and fixed 2026-09-22", live-measured 17.5% macdSignal divergence); the TS
 *     side was corrected to the standard SMA-seeded convention, so Java follows it rather than
 *     preserving the old quirk — parity means matching the live agent's ACTUAL output, and the
 *     live agent's output changed.
 */
public final class MovingAverages {

    private MovingAverages() {
    }

    /**
     * Matches calcSMA: if there isn't a full period yet, returns the latest price unchanged.
     * Empty input returns 0 rather than throwing — mirrors TechnicalIndicators.ts's
     * {@code calculateSMA} ({@code prices[prices.length - 1] || 0}); no live caller passes an
     * empty array, this is defensive hardening at the boundary only.
     */
    public static double sma(double[] prices, int period) {
        if (prices.length == 0) {
            return 0;
        }
        if (prices.length < period) {
            return prices[prices.length - 1];
        }
        double sum = 0;
        for (int i = prices.length - period; i < prices.length; i++) {
            sum += prices[i];
        }
        return sum / period;
    }

    /**
     * Full EMA series (same length as input), mirroring MACDEngine.ts's private
     * {@code calcEMA} exactly as of its 2026-09-22 seeding fix (see the class header): the
     * first {@code warmupLen = min(period, length)} values are all seeded with the SMA of
     * the first {@code warmupLen} prices, then the recursive EMA runs from {@code warmupLen}
     * onward. Empty input returns an empty array, matching TS's {@code []} case.
     */
    public static double[] ema(double[] prices, int period) {
        if (prices.length == 0) {
            return new double[0];
        }
        double[] emas = new double[prices.length];
        double multiplier = 2.0 / (period + 1);
        int warmupLen = Math.min(period, prices.length);
        double seedSum = 0;
        for (int i = 0; i < warmupLen; i++) {
            seedSum += prices[i];
        }
        double seed = seedSum / warmupLen;
        for (int i = 0; i < warmupLen; i++) {
            emas[i] = seed;
        }
        for (int i = warmupLen; i < prices.length; i++) {
            emas[i] = (prices[i] - emas[i - 1]) * multiplier + emas[i - 1];
        }
        return emas;
    }
}
