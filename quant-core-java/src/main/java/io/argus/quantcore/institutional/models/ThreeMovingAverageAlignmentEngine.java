package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.MovingAverages;

/**
 * Three-moving-average alignment filter - Kakushadze &amp; Serur, "151 Trading Strategies" (2018),
 * Section 3.13. A refinement of the classic two-MA crossover (already covered elsewhere in this
 * codebase): with three lengths T1 &lt; T2 &lt; T3, a long signal requires full bullish alignment
 * (MA(T1) &gt; MA(T2) &gt; MA(T3)), not just the fastest crossing the slowest - the paper's own
 * stated purpose is filtering out false signals a plain two-line crossover would take. Liquidation
 * triggers earlier, as soon as the fast/medium ordering itself breaks (MA(T1) &lt;= MA(T2)), before
 * a full reversal - the paper's own asymmetry between entry (stricter) and exit (looser) rules.
 */
public final class ThreeMovingAverageAlignmentEngine {

    private ThreeMovingAverageAlignmentEngine() {
    }

    public record Result(
        double maFast,
        double maMedium,
        double maSlow,
        String alignment // BULLISH (fast>medium>slow), BEARISH (fast<medium<slow), MIXED
    ) {
    }

    /**
     * @param closes chronological closes.
     * @param fastPeriod, mediumPeriod, slowPeriod paper's own example: 3, 10, 21.
     * @return null if there isn't enough history for the slowest MA.
     */
    public static Result evaluate(double[] closes, int fastPeriod, int mediumPeriod, int slowPeriod) {
        if (closes == null || fastPeriod < 1 || mediumPeriod <= fastPeriod || slowPeriod <= mediumPeriod
            || closes.length < slowPeriod) {
            return null;
        }
        double maFast = MovingAverages.sma(closes, fastPeriod);
        double maMedium = MovingAverages.sma(closes, mediumPeriod);
        double maSlow = MovingAverages.sma(closes, slowPeriod);

        String alignment;
        if (maFast > maMedium && maMedium > maSlow) {
            alignment = "BULLISH";
        } else if (maFast < maMedium && maMedium < maSlow) {
            alignment = "BEARISH";
        } else {
            alignment = "MIXED";
        }
        return new Result(maFast, maMedium, maSlow, alignment);
    }

    /** Paper's own worked example: 3/10/21. */
    public static Result evaluate(double[] closes) {
        return evaluate(closes, 3, 10, 21);
    }
}
