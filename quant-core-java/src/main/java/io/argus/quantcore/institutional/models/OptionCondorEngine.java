package io.argus.quantcore.institutional.models;

/**
 * Long/Short Condor (four equidistant-wing strikes, 1-1-1-1) - ASX "Understanding Options
 * Trading" booklet, Strategies 16 (Long Condor) and 22 (Short Condor). Construction: buy A, sell
 * B, sell C, buy D (calls, puts, or a mixed construction - same payoff shape either way, per the
 * source's own note). Formulas independently re-derived from the payoff function (verified by
 * hand across all four price regions) and confirmed to match the source's own stated breakeven
 * formula exactly for both the long AND short variant (unlike OptionButterflyEngine's short
 * variant, where the source's text appears to contain an error - see that class's own doc comment).
 */
public final class OptionCondorEngine {

    private OptionCondorEngine() {
    }

    public enum Position { LONG_CONDOR, SHORT_CONDOR }

    public record Result(
        double breakevenLower,
        double breakevenUpper,
        double maxRisk,
        double maxReward
    ) {
    }

    /**
     * @param strikeA, strikeB, strikeC, strikeD A &lt; B &lt; C &lt; D, with equal outer wing
     *                 widths (B-A == D-C), the standard condor construction.
     * @param netPremium net debit paid (LONG_CONDOR) or net credit received (SHORT_CONDOR); must
     *                   be nonnegative.
     * @return null if strikes are not properly ordered/equal-winged, or netPremium exceeds the
     *         wing width (a structurally impossible quote).
     */
    public static Result evaluate(Position position, double strikeA, double strikeB, double strikeC, double strikeD, double netPremium) {
        if (strikeA <= 0 || strikeB <= strikeA || strikeC <= strikeB || strikeD <= strikeC || netPremium < 0) {
            return null;
        }
        double lowerWing = strikeB - strikeA;
        double upperWing = strikeD - strikeC;
        if (Math.abs(lowerWing - upperWing) > 1e-9) {
            return null;
        }
        if (netPremium > lowerWing) {
            return null;
        }

        double breakevenLower = strikeA + netPremium;
        double breakevenUpper = strikeD - netPremium;
        double plateauValue = lowerWing - netPremium;

        return position == Position.LONG_CONDOR
            ? new Result(breakevenLower, breakevenUpper, netPremium, plateauValue)
            : new Result(breakevenLower, breakevenUpper, plateauValue, netPremium);
    }
}
