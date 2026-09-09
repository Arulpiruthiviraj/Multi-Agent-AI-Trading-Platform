package io.argus.quantcore.institutional.models;

/**
 * Long/Short Strangle (out-of-the-money call at a higher strike + put at a lower strike) -
 * cross-validated across Kawadkar &amp; Kadu (2022) Strategies 7-8 and the ASX "Understanding
 * Options Trading" booklet. Same asymmetric risk/reward structure as {@link OptionStraddleEngine}
 * (see its own doc comment) - the bounded downside is anchored to the PUT strike (the lower one),
 * since that is where the underlying's fall is capped at zero.
 */
public final class OptionStrangleEngine {

    private OptionStrangleEngine() {
    }

    public enum Position { LONG_STRANGLE, SHORT_STRANGLE }

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
     * @param putStrike    A, the lower (put) strike.
     * @param callStrike   B, the higher (call) strike; must exceed putStrike.
     * @param totalPremium combined premium (call + put), paid for LONG_STRANGLE or received for
     *                     SHORT_STRANGLE.
     * @return null if putStrike is not positive, callStrike &lt;= putStrike, or totalPremium is negative.
     */
    public static Result evaluate(Position position, double putStrike, double callStrike, double totalPremium) {
        if (putStrike <= 0 || callStrike <= putStrike || totalPremium < 0) {
            return null;
        }
        double breakevenUpper = callStrike + totalPremium;
        double breakevenLower = putStrike - totalPremium;
        double boundedDownside = putStrike - totalPremium;

        if (position == Position.LONG_STRANGLE) {
            return new Result(breakevenUpper, breakevenLower, totalPremium, totalPremium, Double.POSITIVE_INFINITY, boundedDownside);
        } else {
            return new Result(breakevenUpper, breakevenLower, Double.POSITIVE_INFINITY, boundedDownside, totalPremium, totalPremium);
        }
    }
}
