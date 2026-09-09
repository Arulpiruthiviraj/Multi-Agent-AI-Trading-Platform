package io.argus.quantcore.institutional.models;

/**
 * Long/Short Combo (a.k.a. long/short risk reversal) - Kakushadze &amp; Serur, "151 Trading
 * Strategies" (2018), Sections 2.12-2.13, Eq. 41-52. Distinct from {@link
 * OptionSyntheticStockEngine}'s SPLIT_STRIKE variants (same legs - buy an OTM call, sell an OTM
 * put, or the mirror) in one respect: this class implements the paper's own genuinely piecewise,
 * sign-of-net-premium-dependent breakeven (three cases: H&gt;0, H&lt;0, H=0 gives a range) rather
 * than a single unconditional formula.
 */
public final class OptionComboEngine {

    private OptionComboEngine() {
    }

    public enum Position { LONG_COMBO, SHORT_COMBO }

    public record Result(
        double breakeven, // NaN when netPremium == 0 - see breakevenRangeLower/Upper instead
        Double breakevenRangeLower,
        Double breakevenRangeUpper,
        double maxProfit,
        double maxLoss
    ) {
    }

    /**
     * @param higherStrike, lowerStrike K1 (call strike for LONG_COMBO / put strike for
     *                      SHORT_COMBO) and K2 (the other leg's strike); pass them as
     *                      higherStrike &gt; lowerStrike regardless of which paper-variable (K1 or
     *                      K2) they correspond to - this method sorts out the correct formula
     *                      internally per the paper's own K1/K2 convention for each variant.
     * @param netPremium H: signed, positive = net credit received, negative = net debit paid.
     * @return null if higherStrike &lt;= lowerStrike.
     */
    public static Result evaluate(Position position, double higherStrike, double lowerStrike, double netPremium) {
        if (lowerStrike <= 0 || higherStrike <= lowerStrike) {
            return null;
        }
        double h = netPremium;

        if (position == Position.LONG_COMBO) {
            // Eq. 41-46: buy call at higherStrike (K1), sell put at lowerStrike (K2).
            double maxLoss = lowerStrike + h;
            if (h > 0) {
                return new Result(higherStrike + h, null, null, Double.POSITIVE_INFINITY, maxLoss);
            } else if (h < 0) {
                return new Result(lowerStrike + h, null, null, Double.POSITIVE_INFINITY, maxLoss);
            } else {
                return new Result(Double.NaN, lowerStrike, higherStrike, Double.POSITIVE_INFINITY, maxLoss);
            }
        } else {
            // Eq. 47-52: buy put at lowerStrike (K1), sell call at higherStrike (K2).
            double maxProfit = lowerStrike - h;
            if (h > 0) {
                return new Result(lowerStrike - h, null, null, maxProfit, Double.POSITIVE_INFINITY);
            } else if (h < 0) {
                return new Result(higherStrike - h, null, null, maxProfit, Double.POSITIVE_INFINITY);
            } else {
                return new Result(Double.NaN, lowerStrike, higherStrike, maxProfit, Double.POSITIVE_INFINITY);
            }
        }
    }
}
