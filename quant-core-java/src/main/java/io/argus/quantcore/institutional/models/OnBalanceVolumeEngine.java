package io.argus.quantcore.institutional.models;

/**
 * On-Balance Volume (OBV). Joseph Granville's public-domain indicator (Granville, "New Key to
 * Stock Market Profits", 1963 - practitioner origin, not peer-reviewed, flagged honestly per this
 * catalog's own convention). Cumulative running total: add today's volume when the close rises,
 * subtract it when the close falls, no change on an unchanged close.
 *
 * Strategy: OBV divergence from price - Granville's own reading is that volume (smart money) often
 * leads price. A price downtrend with OBV flat/rising (distribution not confirmed by declining
 * volume-weighted participation) reads bullish; a price uptrend with OBV flat/falling reads
 * bearish. RESEARCH status: real formula, zero live consumer, no claim of validated edge.
 */
public final class OnBalanceVolumeEngine {

    private OnBalanceVolumeEngine() {
    }

    public record Result(
        double obv,
        double previousObv,
        double priceChangePct,
        double obvChangePct,
        String divergenceSignal // BUY (bullish divergence), SELL (bearish divergence), NEUTRAL
    ) {
    }

    /** Full OBV series (same length as input), starting at 0. */
    public static double[] calculate(double[] closes, double[] volumes) {
        int n = closes.length;
        double[] obv = new double[n];
        for (int i = 1; i < n; i++) {
            if (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + volumes[i];
            else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - volumes[i];
            else obv[i] = obv[i - 1];
        }
        return obv;
    }

    /**
     * @param window bars over which to compare the price trend against the OBV trend (e.g. 10).
     * @return null if there isn't enough history.
     */
    public static Result evaluate(double[] closes, double[] volumes, int window) {
        int n = closes.length;
        if (volumes.length != n || window < 1 || n <= window) {
            return null;
        }
        double[] obv = calculate(closes, volumes);
        double priceStart = closes[n - 1 - window];
        double priceEnd = closes[n - 1];
        double obvStart = obv[n - 1 - window];
        double obvEnd = obv[n - 1];
        if (priceStart == 0) {
            return null;
        }
        double priceChangePct = (priceEnd - priceStart) / priceStart;
        // OBV can legitimately be 0 or cross 0, so its own "change" is expressed as a normalized
        // direction rather than a percentage that could divide by (near-)zero.
        double obvChangePct = obvEnd - obvStart;

        boolean bullishDivergence = priceChangePct < 0 && obvChangePct >= 0;
        boolean bearishDivergence = priceChangePct > 0 && obvChangePct <= 0;
        String signal = bullishDivergence ? "BUY" : bearishDivergence ? "SELL" : "NEUTRAL";

        return new Result(obvEnd, obv[n - 2], priceChangePct, obvChangePct, signal);
    }

    /** Conventional 10-bar comparison window. */
    public static Result evaluate(double[] closes, double[] volumes) {
        return evaluate(closes, volumes, 10);
    }
}
