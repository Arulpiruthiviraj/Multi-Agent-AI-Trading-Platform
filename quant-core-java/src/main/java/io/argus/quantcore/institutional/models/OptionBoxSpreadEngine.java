package io.argus.quantcore.institutional.models;

/**
 * Box Spread - ASX "Understanding Options Trading" booklet, Strategy 26: a long bull spread + long
 * bear spread at the same two strikes (or the equivalent short construction), whose value at
 * expiration is "totally independent of the price of the underlying instrument" - a synthetic
 * fixed-income position. The paper's own framing: "the only profit is made if you can buy it for
 * less than fair value or sell it for more than fair value." Fair value is exactly the strike
 * width (A to B), always, regardless of the underlying's path - a real, verifiable identity: a
 * bull call spread pays (S-A) capped at (B-A), a bear put spread pays (B-S) capped at (B-A); a
 * long box combines both and its combined payoff is provably the constant (B-A) for every S.
 */
public final class OptionBoxSpreadEngine {

    private OptionBoxSpreadEngine() {
    }

    public record Result(
        double fairValue,
        double edge // fairValue - netCost if bought; netCredit - fairValue if sold. Sign convention below.
    ) {
    }

    /**
     * @param lowStrike, highStrike the box's two strikes; highStrike must exceed lowStrike.
     * @param netCost    price paid to buy the box (a genuine box is always bought for less than
     *                   fair value to be worth doing - pass the actual observed net cost, not a
     *                   theoretical one).
     * @return null if highStrike &lt;= lowStrike.
     */
    public static Result evaluateLongBox(double lowStrike, double highStrike, double netCost) {
        if (lowStrike <= 0 || highStrike <= lowStrike) {
            return null;
        }
        double fairValue = highStrike - lowStrike;
        double edge = fairValue - netCost; // positive = bought below fair value (real edge)
        return new Result(fairValue, edge);
    }

    /** Mirror of {@link #evaluateLongBox} for a short box (sold for netCredit; edge is positive when netCredit exceeds fair value). */
    public static Result evaluateShortBox(double lowStrike, double highStrike, double netCredit) {
        if (lowStrike <= 0 || highStrike <= lowStrike) {
            return null;
        }
        double fairValue = highStrike - lowStrike;
        double edge = netCredit - fairValue;
        return new Result(fairValue, edge);
    }
}
