package io.argus.quantcore.institutional.models;

/**
 * Wilder's Average Directional Index (ADX) plus +DI/-DI - the standard trend-strength measure
 * (distinct from momentum's direction: ADX says HOW STRONG a trend is, not which way).
 * Real, textbook Wilder smoothing (Welles Wilder, "New Concepts in Technical Trading Systems",
 * 1978) - no shortcuts, no invented constants.
 */
public final class TrendStrengthEngine {

    private TrendStrengthEngine() {
    }

    public record Result(
        double adx,
        double plusDI,
        double minusDI,
        boolean strongTrend,
        boolean trendingUp
    ) {
    }

    /** ADX >= this is conventionally "trending" (Wilder's own rule of thumb). */
    public static final double STRONG_TREND_THRESHOLD = 25.0;

    /**
     * @param highs  chronological session highs.
     * @param lows   chronological session lows, same length.
     * @param closes chronological closes, same length.
     * @param period Wilder's default is 14.
     * @return null if there isn't enough data (needs roughly 2*period bars for the smoothing to settle).
     */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, int period) {
        int n = closes.length;
        if (highs.length != n || lows.length != n || period < 1 || n < 2 * period + 1) {
            return null;
        }

        double[] tr = new double[n];
        double[] plusDM = new double[n];
        double[] minusDM = new double[n];
        for (int i = 1; i < n; i++) {
            double highLow = highs[i] - lows[i];
            double highPrevClose = Math.abs(highs[i] - closes[i - 1]);
            double lowPrevClose = Math.abs(lows[i] - closes[i - 1]);
            tr[i] = Math.max(highLow, Math.max(highPrevClose, lowPrevClose));

            double upMove = highs[i] - highs[i - 1];
            double downMove = lows[i - 1] - lows[i];
            plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0.0;
            minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0.0;
        }

        // Wilder smoothing: seed with a simple sum over the first `period` real values, then
        // recursively smooth (smoothed[i] = smoothed[i-1] - smoothed[i-1]/period + value[i]).
        double smoothedTr = sumRange(tr, 1, period + 1);
        double smoothedPlusDM = sumRange(plusDM, 1, period + 1);
        double smoothedMinusDM = sumRange(minusDM, 1, period + 1);

        double[] dx = new double[n];
        double plusDI = 0, minusDI = 0;
        for (int i = period + 1; i < n; i++) {
            smoothedTr = smoothedTr - (smoothedTr / period) + tr[i];
            smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDM[i];
            smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDM[i];

            plusDI = smoothedTr != 0 ? 100.0 * (smoothedPlusDM / smoothedTr) : 0.0;
            minusDI = smoothedTr != 0 ? 100.0 * (smoothedMinusDM / smoothedTr) : 0.0;
            double diSum = plusDI + minusDI;
            dx[i] = diSum != 0 ? 100.0 * (Math.abs(plusDI - minusDI) / diSum) : 0.0;
        }

        // ADX itself is a Wilder-smoothed average of DX, seeded with a simple average of the
        // first `period` real DX values (starting right after the DI smoothing settles).
        int dxStart = period + 1;
        int adxSeedEnd = Math.min(dxStart + period, n);
        if (adxSeedEnd - dxStart < 1) {
            return null;
        }
        double adx = sumRange(dx, dxStart, adxSeedEnd) / (adxSeedEnd - dxStart);
        for (int i = adxSeedEnd; i < n; i++) {
            adx = ((adx * (period - 1)) + dx[i]) / period;
        }

        return new Result(adx, plusDI, minusDI, adx >= STRONG_TREND_THRESHOLD, plusDI > minusDI);
    }

    private static double sumRange(double[] values, int fromInclusive, int toExclusive) {
        double s = 0;
        for (int i = fromInclusive; i < toExclusive; i++) s += values[i];
        return s;
    }
}
