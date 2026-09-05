package io.argus.quantcore.institutional.models;

/**
 * Overnight-gap / intraday-reversal family: decomposes each session into its overnight gap
 * (prior close -> today's open) and its intraday move (today's open -> today's close), the real
 * inputs a gap-fade or overnight-reversal strategy needs. `overnightReversalRate` is a real,
 * historical frequency (not a fabricated probability) - how often, in this window, the intraday
 * move actually ran opposite to the overnight gap.
 */
public final class IntradayGapReversalEngine {

    private IntradayGapReversalEngine() {
    }

    public record Result(
        double gapPct,
        double intradayReturnPct,
        boolean extremeGap,
        String gapFadeSignal,
        double overnightReversalRate
    ) {
    }

    /**
     * @param opens          session opens, chronological.
     * @param closes         session closes, chronological, same length, closes[i-1] is "prior close".
     * @param window         how many recent sessions to compute overnightReversalRate over.
     * @param extremeGapPct  absolute gap size (e.g. 0.02 = 2%) treated as fade-worthy.
     * @return null if there isn't at least window+1 real sessions.
     */
    public static Result evaluate(double[] opens, double[] closes, int window, double extremeGapPct) {
        int n = closes.length;
        if (opens.length != n || window < 1 || n <= window) {
            return null;
        }

        int reversals = 0;
        int counted = 0;
        double lastGap = 0;
        double lastIntraday = 0;
        for (int i = n - window; i < n; i++) {
            if (closes[i - 1] == 0 || opens[i] == 0) continue;
            double gap = (opens[i] - closes[i - 1]) / closes[i - 1];
            double intraday = (closes[i] - opens[i]) / opens[i];
            if (Math.signum(gap) != 0 && Math.signum(intraday) != 0 && Math.signum(gap) != Math.signum(intraday)) {
                reversals++;
            }
            counted++;
            if (i == n - 1) {
                lastGap = gap;
                lastIntraday = intraday;
            }
        }
        double reversalRate = counted > 0 ? reversals / (double) counted : 0.0;
        boolean extreme = Math.abs(lastGap) >= extremeGapPct;
        String fadeSignal = !extreme ? "NEUTRAL" : (lastGap > 0 ? "SELL" : "BUY");

        return new Result(lastGap, lastIntraday, extreme, fadeSignal, reversalRate);
    }
}
