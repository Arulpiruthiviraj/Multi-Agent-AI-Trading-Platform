package io.argus.quantcore.institutional.models;

/**
 * Two-leg vertical option spreads - Kawadkar &amp; Kadu (2022) Strategies 9-12 (Bull Call, Bull
 * Put, Bear Call, Bear Put spreads), cross-validated against Fidelity's "A Quick Guide to Trading
 * Options" (fidelity.com/options), which states the identical breakeven/max-risk/max-reward
 * formulas for all four. netPremium uses one consistent signed convention throughout: POSITIVE =
 * net credit received (Bull Put, Bear Call), NEGATIVE = net debit paid (Bull Call, Bear Put) -
 * this makes maxRisk + maxReward == width (the strike spacing) a universal invariant across all
 * four variants, verified in this class's own tests.
 */
public final class OptionVerticalSpreadEngine {

    private OptionVerticalSpreadEngine() {
    }

    public enum SpreadType { BULL_CALL, BULL_PUT, BEAR_CALL, BEAR_PUT }

    public record Result(double breakeven, double maxRisk, double maxReward) {
    }

    /**
     * @param type         which of the 4 vertical spreads.
     * @param lowerStrike, higherStrike the two legs' strikes (lowerStrike &lt; higherStrike required).
     * @param netPremium   signed: positive = net credit received (Bull Put, Bear Call), negative =
     *                     net debit paid (Bull Call, Bear Put). Not defaulted - caller supplies
     *                     the real, observed net premium.
     * @return null if higherStrike &lt;= lowerStrike, or |netPremium| exceeds the strike width
     *         (a structurally impossible quote, not silently clamped).
     */
    public static Result evaluate(SpreadType type, double lowerStrike, double higherStrike, double netPremium) {
        if (higherStrike <= lowerStrike) {
            return null;
        }
        double width = higherStrike - lowerStrike;
        if (Math.abs(netPremium) > width) {
            return null;
        }

        double breakeven;
        double maxRisk;
        double maxReward;

        switch (type) {
            case BULL_CALL -> {
                breakeven = lowerStrike - netPremium;
                maxRisk = -netPremium;
                maxReward = width + netPremium;
            }
            case BEAR_PUT -> {
                breakeven = higherStrike + netPremium;
                maxRisk = -netPremium;
                maxReward = width + netPremium;
            }
            case BULL_PUT -> {
                breakeven = higherStrike - netPremium;
                maxReward = netPremium;
                maxRisk = width - netPremium;
            }
            case BEAR_CALL -> {
                breakeven = lowerStrike + netPremium;
                maxReward = netPremium;
                maxRisk = width - netPremium;
            }
            default -> throw new IllegalStateException("Unhandled spread type: " + type);
        }

        return new Result(breakeven, maxRisk, maxReward);
    }
}
