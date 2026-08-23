package io.argus.quantcore.indicators;

/**
 * SMA/EMA, ported byte-for-byte from the live TypeScript reference implementations so parity
 * tests can assert exact (epsilon-bounded) agreement:
 *   - {@link #sma} mirrors {@code calcSMA} in src/server/services/technicalSignal.ts.
 *   - {@link #ema} mirrors the private {@code calcEMA} helper in src/server/engines/MACDEngine.ts
 *     — note this seeds the series with the raw first price (not a period-SMA seed), which is a
 *     deliberate TS quirk this port preserves rather than "correcting", since parity with the
 *     live agent's actual output is the whole point of this migration.
 */
public final class MovingAverages {

    private MovingAverages() {
    }

    /** Matches calcSMA: if there isn't a full period yet, returns the latest price unchanged. */
    public static double sma(double[] prices, int period) {
        if (prices.length < period) {
            return prices[prices.length - 1];
        }
        double sum = 0;
        for (int i = prices.length - period; i < prices.length; i++) {
            sum += prices[i];
        }
        return sum / period;
    }

    /** Full EMA series (same length as input), first-price-seeded to match MACDEngine.ts exactly. */
    public static double[] ema(double[] prices, int period) {
        if (prices.length == 0) {
            return new double[0];
        }
        double[] emas = new double[prices.length];
        double multiplier = 2.0 / (period + 1);
        emas[0] = prices[0];
        for (int i = 1; i < prices.length; i++) {
            emas[i] = (prices[i] - emas[i - 1]) * multiplier + emas[i - 1];
        }
        return emas;
    }
}
