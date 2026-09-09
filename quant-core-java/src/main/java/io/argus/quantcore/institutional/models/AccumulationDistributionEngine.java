package io.argus.quantcore.institutional.models;

/**
 * Accumulation/Distribution Line (A/D). Marc Chaikin's public-domain, close-location-weighted
 * volume-flow indicator (1970s practitioner technique, no single canonical peer-reviewed source).
 * Per bar:
 *   moneyFlowMultiplier = ((close - low) - (high - close)) / (high - low)   in [-1, 1]
 *   moneyFlowVolume = moneyFlowMultiplier * volume
 *   A/D = cumulative sum of moneyFlowVolume
 * A close near the high of its bar's range contributes positively (accumulation); a close near
 * the low contributes negatively (distribution) - weighted by that bar's volume, unlike OBV's
 * simple up/down-day binary.
 *
 * Strategy: same divergence reading as OnBalanceVolumeEngine.java, applied to this more granular
 * (intra-bar-range-aware) flow measure - a real, differently-sourced signal, not a duplicate.
 * RESEARCH status: real formula, zero live consumer, no claim of validated edge.
 */
public final class AccumulationDistributionEngine {

    private AccumulationDistributionEngine() {
    }

    public record Result(
        double adLine,
        double previousAdLine,
        double priceChangePct,
        double adLineChange,
        String divergenceSignal // BUY (bullish divergence), SELL (bearish divergence), NEUTRAL
    ) {
    }

    /** Full A/D line series (same length as input), starting at 0. A zero-range bar (high == low) contributes 0. */
    public static double[] calculate(double[] highs, double[] lows, double[] closes, double[] volumes) {
        int n = closes.length;
        double[] ad = new double[n];
        for (int i = 0; i < n; i++) {
            double range = highs[i] - lows[i];
            double moneyFlowVolume = 0;
            if (range > 0) {
                double moneyFlowMultiplier = ((closes[i] - lows[i]) - (highs[i] - closes[i])) / range;
                moneyFlowVolume = moneyFlowMultiplier * volumes[i];
            }
            ad[i] = (i == 0 ? 0 : ad[i - 1]) + moneyFlowVolume;
        }
        return ad;
    }

    /**
     * @param window bars over which to compare the price trend against the A/D-line trend.
     */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, double[] volumes, int window) {
        int n = closes.length;
        if (highs.length != n || lows.length != n || volumes.length != n || window < 1 || n <= window) {
            return null;
        }
        double[] ad = calculate(highs, lows, closes, volumes);
        double priceStart = closes[n - 1 - window];
        double priceEnd = closes[n - 1];
        if (priceStart == 0) {
            return null;
        }
        double priceChangePct = (priceEnd - priceStart) / priceStart;
        double adChange = ad[n - 1] - ad[n - 1 - window];

        boolean bullishDivergence = priceChangePct < 0 && adChange >= 0;
        boolean bearishDivergence = priceChangePct > 0 && adChange <= 0;
        String signal = bullishDivergence ? "BUY" : bearishDivergence ? "SELL" : "NEUTRAL";

        return new Result(ad[n - 1], ad[n - 2], priceChangePct, adChange, signal);
    }

    /** Conventional 10-bar comparison window (matching OnBalanceVolumeEngine's own default). */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, double[] volumes) {
        return evaluate(highs, lows, closes, volumes, 10);
    }
}
