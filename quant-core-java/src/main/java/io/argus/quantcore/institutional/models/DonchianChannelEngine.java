package io.argus.quantcore.institutional.models;

/**
 * Donchian channel breakout (classical N-bar high/low channel) - a distinct technique from
 * MomentumBreakout.java's structural-break logic, not a duplicate: the channel bounds here are
 * purely the rolling max(high)/min(low) over N bars, with no regime/volume/VWAP conditions.
 */
public final class DonchianChannelEngine {

    private DonchianChannelEngine() {
    }

    public record Result(
        double upperChannel,
        double lowerChannel,
        double currentClose,
        boolean breakoutUp,
        boolean breakoutDown,
        double channelWidthPct
    ) {
    }

    /**
     * @param highs  chronological session highs.
     * @param lows   chronological session lows, same length as highs.
     * @param closes chronological closes, same length.
     * @param period lookback bars for the channel (excludes the current bar itself, the classical
     *               Donchian convention - so "breakout" means the current bar closing beyond the
     *               PRIOR N bars' range, not trivially inside its own contribution to that range).
     * @return null if there isn't at least period+1 bars of real data.
     */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, int period) {
        int n = closes.length;
        if (highs.length != n || lows.length != n || period < 1 || n <= period) {
            return null;
        }
        double upper = Double.NEGATIVE_INFINITY;
        double lower = Double.POSITIVE_INFINITY;
        for (int i = n - 1 - period; i < n - 1; i++) {
            if (highs[i] > upper) upper = highs[i];
            if (lows[i] < lower) lower = lows[i];
        }
        double close = closes[n - 1];
        boolean breakoutUp = close > upper;
        boolean breakoutDown = close < lower;
        double mid = (upper + lower) / 2.0;
        double widthPct = mid != 0 ? ((upper - lower) / mid) * 100.0 : 0.0;
        return new Result(upper, lower, close, breakoutUp, breakoutDown, widthPct);
    }
}
