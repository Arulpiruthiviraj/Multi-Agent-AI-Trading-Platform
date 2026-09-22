package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.MovingAverages;

/**
 * SMA +/- (multiplier * population-stddev) bands with a CALLER-SUPPLIED multiplier - distinct
 * from io.argus.quantcore.indicators.Bollinger (fixed 2.0 multiplier, ported byte-for-byte from
 * the TS live path). The Tan (2025) baseline reproduction and its own adaptive-parameter research
 * (multiplier sweep 1.5-2.5) both need a variable multiplier, which the live-path class
 * deliberately does not expose. Reuses MovingAverages.sma() rather than recomputing it.
 */
public final class CryptoBollingerBands {
    private CryptoBollingerBands() {
    }

    public record Bands(double middle, double upper, double lower) {
    }

    public static Bands calculate(double[] prices, int period, double stdDevMultiplier) {
        double sma = MovingAverages.sma(prices, period);
        int from = Math.max(0, prices.length - period);
        double sumSq = 0;
        for (int i = from; i < prices.length; i++) {
            double d = prices[i] - sma;
            sumSq += d * d;
        }
        double stdDev = Math.sqrt(sumSq / period);
        return new Bands(sma, sma + stdDev * stdDevMultiplier, sma - stdDev * stdDevMultiplier);
    }
}
