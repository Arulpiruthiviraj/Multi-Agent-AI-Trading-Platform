package io.argus.quantcore.institutional.models;

/**
 * Long/Short Straddle (same-strike call + put) - cross-validated across Kawadkar &amp; Kadu (2022)
 * Strategies 5-6 and the ASX "Understanding Options Trading" booklet. Both bought legs (long
 * straddle) or both sold legs (short straddle) share the same strike and expiration.
 *
 * <p>ASX gives a genuinely asymmetric structure the other source states only loosely: the side
 * that PAID premium (long straddle) has a single bounded max loss (=total premium paid, same in
 * either direction), but its max PROFIT is asymmetric - unlimited as the underlying rises, but
 * bounded at (strike - total premium) as it falls, since the underlying cannot go below zero. The
 * side that RECEIVED premium (short straddle) is the mirror image: bounded max profit
 * (=total premium received), asymmetric max loss (unlimited up, bounded at strike - premium down).
 */
public final class OptionStraddleEngine {

    private OptionStraddleEngine() {
    }

    public enum Position { LONG_STRADDLE, SHORT_STRADDLE }

    public record Result(
        double breakevenUpper,
        double breakevenLower,
        double maxRiskUpper,
        double maxRiskLower,
        double maxRewardUpper,
        double maxRewardLower
    ) {
    }

    /**
     * @param strike       the common strike of both legs.
     * @param totalPremium combined premium (call + put), paid for LONG_STRADDLE or received for
     *                     SHORT_STRADDLE.
     * @return null if strike is not positive or totalPremium is negative.
     */
    public static Result evaluate(Position position, double strike, double totalPremium) {
        if (strike <= 0 || totalPremium < 0) {
            return null;
        }
        double breakevenUpper = strike + totalPremium;
        double breakevenLower = strike - totalPremium;
        double boundedDownside = strike - totalPremium;

        if (position == Position.LONG_STRADDLE) {
            return new Result(breakevenUpper, breakevenLower, totalPremium, totalPremium, Double.POSITIVE_INFINITY, boundedDownside);
        } else {
            return new Result(breakevenUpper, breakevenLower, Double.POSITIVE_INFINITY, boundedDownside, totalPremium, totalPremium);
        }
    }
}
