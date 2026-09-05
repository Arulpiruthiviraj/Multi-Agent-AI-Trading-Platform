package io.argus.quantcore.institutional.models;

/**
 * Classical Stochastic Oscillator (George Lane): %K = position of the current close within its
 * own trailing high/low range, %D = a simple moving average of %K. Textbook formula, no shortcuts.
 */
public final class StochasticOscillatorEngine {

    private StochasticOscillatorEngine() {
    }

    public record Result(
        double percentK,
        double percentD,
        boolean overbought,
        boolean oversold,
        boolean bullishCross,
        boolean bearishCross
    ) {
    }

    public static final double DEFAULT_OVERBOUGHT = 80.0;
    public static final double DEFAULT_OVERSOLD = 20.0;

    private static double percentKAt(double[] highs, double[] lows, double[] closes, int period, int endExclusive) {
        double highestHigh = Double.NEGATIVE_INFINITY;
        double lowestLow = Double.POSITIVE_INFINITY;
        for (int i = endExclusive - period; i < endExclusive; i++) {
            if (highs[i] > highestHigh) highestHigh = highs[i];
            if (lows[i] < lowestLow) lowestLow = lows[i];
        }
        double range = highestHigh - lowestLow;
        if (range == 0) return 50.0; // degenerate flat range - neither overbought nor oversold
        return 100.0 * (closes[endExclusive - 1] - lowestLow) / range;
    }

    /**
     * @param period    %K lookback (Lane's default is 14).
     * @param dPeriod   %D smoothing window over %K (Lane's default is 3).
     * @return null if there isn't enough history for both %K and its %D smoothing.
     */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, int period, int dPeriod) {
        int n = closes.length;
        if (highs.length != n || lows.length != n || period < 1 || dPeriod < 1 || n < period + dPeriod) {
            return null;
        }
        double[] percentKSeries = new double[dPeriod + 1];
        for (int j = 0; j < dPeriod + 1; j++) {
            int end = n - (dPeriod - j);
            percentKSeries[j] = percentKAt(highs, lows, closes, period, end);
        }
        double percentK = percentKSeries[dPeriod];
        double percentD = 0, prevPercentD = 0;
        for (int j = 1; j <= dPeriod; j++) percentD += percentKSeries[j];
        percentD /= dPeriod;
        for (int j = 0; j < dPeriod; j++) prevPercentD += percentKSeries[j];
        prevPercentD /= dPeriod;

        double prevPercentK = percentKSeries[dPeriod - 1];
        boolean bullishCross = prevPercentK <= prevPercentD && percentK > percentD;
        boolean bearishCross = prevPercentK >= prevPercentD && percentK < percentD;

        return new Result(percentK, percentD, percentK >= DEFAULT_OVERBOUGHT, percentK <= DEFAULT_OVERSOLD, bullishCross, bearishCross);
    }
}
