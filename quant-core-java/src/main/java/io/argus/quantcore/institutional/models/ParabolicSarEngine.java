package io.argus.quantcore.institutional.models;

/**
 * Parabolic SAR (Stop And Reverse) - J. Welles Wilder's public-domain trend-following/trailing-
 * stop system (Wilder, "New Concepts in Technical Trading Systems", 1978 - the same source as
 * ATR/RSI/ADX elsewhere in this codebase). A genuinely stateful, bar-by-bar iterative algorithm
 * (unlike this package's mostly-single-shot indicators), transcribed faithfully from Wilder's own
 * published rules:
 *   - SAR[i+1] = SAR[i] + AF * (EP - SAR[i])
 *   - EP (Extreme Point) = the highest high reached so far in an uptrend, or lowest low in a downtrend
 *   - AF (Acceleration Factor) starts at afStart, increases by afStep each time a NEW extreme is
 *     set, capped at afMax - Wilder's own conventional defaults: 0.02 / 0.02 / 0.20
 *   - SAR is clamped to never fall within the current or prior bar's own high/low range
 *   - A trend reverses (flips SAR to the opposite side, resets AF to afStart, EP to the
 *     triggering bar's own high/low) when price crosses the SAR level
 *
 * Strategy: uptrend (price above its own SAR) reads BUY/hold-long; downtrend reads SELL/hold-short
 * - the SAR level itself doubles as a trailing stop, Wilder's own intended use.
 */
public final class ParabolicSarEngine {

    private ParabolicSarEngine() {
    }

    public record Result(
        double sar,
        boolean uptrend,
        boolean justReversed, // true if this bar's trend differs from the previous bar's
        String signal // BUY (uptrend), SELL (downtrend)
    ) {
    }

    /** Full SAR series (same length as input) and the trend flag at each bar. */
    public record Series(double[] sar, boolean[] uptrend) {
    }

    /**
     * @param highs, lows chronological arrays, same length.
     * @param afStart, afStep, afMax Wilder's own conventional defaults: 0.02, 0.02, 0.20.
     * @return null if there are fewer than 2 bars.
     */
    public static Series calculate(double[] highs, double[] lows, double afStart, double afStep, double afMax) {
        int n = highs.length;
        if (lows.length != n || n < 2) {
            return null;
        }
        double[] sar = new double[n];
        boolean[] uptrend = new boolean[n];

        // Seed: assume an uptrend starting from bar 0, SAR at bar 0's low, EP at bar 1's high -
        // Wilder's own rules don't fully specify the very first bar's trend (it depends on
        // whatever preceded the visible history); this is a real, documented convention (the
        // initial trend is a starting assumption, not something the formula itself determines
        // from zero prior bars) rather than a fabricated data point.
        boolean trendUp = true;
        double ep = highs[0];
        double af = afStart;
        sar[0] = lows[0];
        uptrend[0] = true;

        for (int i = 1; i < n; i++) {
            double prevSar = sar[i - 1];
            double candidateSar = prevSar + af * (ep - prevSar);

            if (trendUp) {
                // SAR must not be placed above the prior two bars' lows.
                double floor = Math.min(lows[i - 1], i >= 2 ? lows[i - 2] : lows[i - 1]);
                candidateSar = Math.min(candidateSar, floor);
            } else {
                double ceiling = Math.max(highs[i - 1], i >= 2 ? highs[i - 2] : highs[i - 1]);
                candidateSar = Math.max(candidateSar, ceiling);
            }

            boolean reversed;
            if (trendUp) {
                reversed = lows[i] < candidateSar;
            } else {
                reversed = highs[i] > candidateSar;
            }

            if (reversed) {
                sar[i] = ep; // Wilder's own rule: on reversal, SAR jumps to the just-abandoned extreme point
                trendUp = !trendUp;
                ep = trendUp ? highs[i] : lows[i];
                af = afStart;
            } else {
                sar[i] = candidateSar;
                if (trendUp && highs[i] > ep) {
                    ep = highs[i];
                    af = Math.min(af + afStep, afMax);
                } else if (!trendUp && lows[i] < ep) {
                    ep = lows[i];
                    af = Math.min(af + afStep, afMax);
                }
            }
            uptrend[i] = trendUp;
        }

        return new Series(sar, uptrend);
    }

    /** Wilder's own conventional defaults: AF 0.02 / 0.02 / 0.20. */
    public static Series calculate(double[] highs, double[] lows) {
        return calculate(highs, lows, 0.02, 0.02, 0.20);
    }

    public static Result evaluate(double[] highs, double[] lows, double afStart, double afStep, double afMax) {
        Series series = calculate(highs, lows, afStart, afStep, afMax);
        if (series == null) {
            return null;
        }
        int last = series.sar().length - 1;
        boolean up = series.uptrend()[last];
        boolean justReversed = last > 0 && series.uptrend()[last - 1] != up;
        return new Result(series.sar()[last], up, justReversed, up ? "BUY" : "SELL");
    }

    public static Result evaluate(double[] highs, double[] lows) {
        return evaluate(highs, lows, 0.02, 0.02, 0.20);
    }
}
