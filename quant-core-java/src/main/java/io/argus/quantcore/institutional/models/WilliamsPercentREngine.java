package io.argus.quantcore.institutional.models;

/**
 * Williams %R - Larry Williams' public-domain momentum oscillator (1970s practitioner technique).
 * %R = (highestHigh(period) - close) / (highestHigh(period) - lowestLow(period)) * -100, ranging
 * -100 to 0. Conceptually the inverse framing of the Stochastic oscillator (StochasticOscillator
 * Engine.java, already implemented) - both measure a close's position within its own recent
 * range, but Williams' own convention flips the sign and doesn't smooth with a moving average the
 * way %K/%D do, so this is a real, differently-behaved indicator, not a duplicate.
 *
 * Strategy: Williams' own standard bands are -20 to 0 (overbought) and -100 to -80 (oversold) -
 * a universally standard convention for this specific indicator, not an invented threshold.
 */
public final class WilliamsPercentREngine {

    private WilliamsPercentREngine() {
    }

    public record Result(
        double percentR,
        boolean overbought,
        boolean oversold,
        String signal // BUY (oversold), SELL (overbought), NEUTRAL
    ) {
    }

    /**
     * @param period conventional default is 14.
     * @return null if there isn't enough history, or the period's range is exactly zero (a
     *         genuinely flat high==low window - undefined, not fabricated as 0 or -100).
     */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, int period) {
        int n = closes.length;
        if (highs.length != n || lows.length != n || period < 1 || n < period) {
            return null;
        }
        double highestHigh = Double.NEGATIVE_INFINITY;
        double lowestLow = Double.POSITIVE_INFINITY;
        for (int i = n - period; i < n; i++) {
            if (highs[i] > highestHigh) highestHigh = highs[i];
            if (lows[i] < lowestLow) lowestLow = lows[i];
        }
        double range = highestHigh - lowestLow;
        if (range == 0) {
            return null;
        }
        double percentR = (highestHigh - closes[n - 1]) / range * -100;
        boolean overbought = percentR >= -20;
        boolean oversold = percentR <= -80;
        String signal = oversold ? "BUY" : overbought ? "SELL" : "NEUTRAL";
        return new Result(percentR, overbought, oversold, signal);
    }

    /** Conventional 14-period default. */
    public static Result evaluate(double[] highs, double[] lows, double[] closes) {
        return evaluate(highs, lows, closes, 14);
    }
}
