package io.argus.quantcore.indicators;

/**
 * 20-period SMA ± 2 population-standard-deviation bands, ported byte-for-byte from
 * src/server/services/technicalSignal.ts's {@code calcBollingerBands} (population variance,
 * i.e. divided by {@code period}, not {@code period - 1} — matches the TS source exactly).
 */
public final class Bollinger {

    private Bollinger() {
    }

    public record Bands(double upper, double lower) {
    }

    public static Bands calculate(double[] prices, int period) {
        double sma = MovingAverages.sma(prices, period);
        int from = Math.max(0, prices.length - period);
        double sumSq = 0;
        for (int i = from; i < prices.length; i++) {
            double d = prices[i] - sma;
            sumSq += d * d;
        }
        double stdDev = Math.sqrt(sumSq / period);
        return new Bands(sma + stdDev * 2, sma - stdDev * 2);
    }

    /** Default 20-period, matching config/quantThresholds.json's bollingerPeriod. */
    public static Bands calculate(double[] prices) {
        return calculate(prices, 20);
    }
}
