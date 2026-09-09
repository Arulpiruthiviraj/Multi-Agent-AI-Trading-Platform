package io.argus.quantcore.institutional.models;

/**
 * Long/Short Butterfly (equidistant three-strike, 1-2-1 ratio) - cross-validated across Kawadkar
 * &amp; Kadu (2022) Strategies 13-14 (calls only) and the ASX "Understanding Options Trading"
 * booklet (which notes all-call, all-put, and mixed call/put constructions give the identical
 * payoff, since it is the strike structure, not the option type, that determines the shape).
 *
 * <p>Breakeven derivation note: this class's breakeven formula (A + netPremium, C - netPremium,
 * for BOTH long and short) was independently re-derived from the payoff function (verified by
 * hand: Long payoff = -netDebit + max(S-A,0) - 2*max(S-B,0) + max(S-C,0), which crosses zero at
 * exactly A+netDebit and C-netDebit) rather than transcribed from the source's own text for the
 * short variant, which states breakevens as "B plus or minus the cost of the spread" - that
 * phrasing does not match a from-scratch derivation of the short payoff (a pure sign-mirror of the
 * long payoff with net credit in place of net debit, which necessarily crosses zero at the SAME
 * strike-anchored points, A+netCredit and C-netCredit) and does not match the source's OWN stated
 * long-butterfly breakeven formula (A + cost, C - cost), which this derivation exactly reproduces.
 */
public final class OptionButterflyEngine {

    private OptionButterflyEngine() {
    }

    public enum Position { LONG_BUTTERFLY, SHORT_BUTTERFLY }

    public record Result(
        double breakevenLower,
        double breakevenUpper,
        double maxRisk,
        double maxReward
    ) {
    }

    /**
     * @param lowStrike, midStrike, highStrike A &lt; B &lt; C, equidistant (B-A == C-B).
     * @param netPremium   net debit paid (LONG_BUTTERFLY) or net credit received (SHORT_BUTTERFLY);
     *                     must be nonnegative.
     * @return null if strikes are not equidistant/ordered, or netPremium exceeds the wing width
     *         (a structurally impossible quote).
     */
    public static Result evaluate(Position position, double lowStrike, double midStrike, double highStrike, double netPremium) {
        if (lowStrike <= 0 || midStrike <= lowStrike || highStrike <= midStrike || netPremium < 0) {
            return null;
        }
        double lowerWing = midStrike - lowStrike;
        double upperWing = highStrike - midStrike;
        if (Math.abs(lowerWing - upperWing) > 1e-9) {
            return null;
        }
        if (netPremium > lowerWing) {
            return null;
        }

        double breakevenLower = lowStrike + netPremium;
        double breakevenUpper = highStrike - netPremium;
        double centerValue = lowerWing - netPremium;

        return position == Position.LONG_BUTTERFLY
            ? new Result(breakevenLower, breakevenUpper, netPremium, centerValue)
            : new Result(breakevenLower, breakevenUpper, centerValue, netPremium);
    }
}
