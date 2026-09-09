package io.argus.quantcore.institutional.models;

/**
 * Single-leg option payoff/breakeven. Primary source: Kawadkar &amp; Kadu, "Options Trading
 * Strategies - A Guide for New Investors," SAMRIDDHI: A Journal of Physical Sciences, Engineering
 * and Technology, 2022, Strategies 1-4 (Long Call, Short Call, Long Put, Short Put). Pure
 * arithmetic given a strike, premium, and spot price at expiry - no options chain/Greeks data
 * needed for the calculation itself (Argus has no options data feed or execution path today; this
 * is a RESEARCH-status calculator built ahead of that capability, per explicit operator direction).
 *
 * <p>Bounded put risk/reward: the ASX "Understanding Options Trading" booklet (asx.com.au/options)
 * gives the mathematically precise, bounded formula for a put's max loss/profit - strike minus
 * premium, since the underlying cannot fall below zero - correcting an imprecision in two other
 * sources (Kawadkar/Kadu 2022 and Fidelity's own "Quick Guide to Trading Options"), which both
 * describe long-put reward and short-put risk simply as "Infinite" (a common industry
 * simplification, not literally true). Calls remain genuinely unbounded (a share price has no
 * theoretical ceiling), so LONG_CALL reward and SHORT_CALL risk stay Double.POSITIVE_INFINITY -
 * all three sources agree on that half.
 */
public final class OptionSingleLegEngine {

    private OptionSingleLegEngine() {
    }

    public enum Position { LONG_CALL, SHORT_CALL, LONG_PUT, SHORT_PUT }

    public record Result(
        double breakeven,
        double maxRisk,
        double maxReward,
        double payoffAtExpiry // net of premium
    ) {
    }

    /**
     * @param position   which of the 4 single-leg strategies.
     * @param strike     exercise price.
     * @param premium    premium paid (long positions) or received (short positions); must be
     *                   nonnegative.
     * @param spotAtExpiry underlying price at expiry, for computing the realized payoff. Pass
     *                   NaN if only breakeven/maxRisk/maxReward are needed (payoffAtExpiry will
     *                   be NaN in the result).
     * @return null if strike or premium is not positive/nonnegative as required.
     */
    public static Result evaluate(Position position, double strike, double premium, double spotAtExpiry) {
        if (strike <= 0 || premium < 0) {
            return null;
        }
        double breakeven;
        double maxRisk;
        double maxReward;
        double intrinsic;

        switch (position) {
            case LONG_CALL -> {
                breakeven = strike + premium;
                maxRisk = premium;
                maxReward = Double.POSITIVE_INFINITY;
                intrinsic = Math.max(spotAtExpiry - strike, 0);
            }
            case SHORT_CALL -> {
                breakeven = strike + premium;
                maxRisk = Double.POSITIVE_INFINITY;
                maxReward = premium;
                intrinsic = -Math.max(spotAtExpiry - strike, 0);
            }
            case LONG_PUT -> {
                breakeven = strike - premium;
                maxRisk = premium;
                maxReward = strike - premium; // ASX's precise bounded formula, not Double.POSITIVE_INFINITY
                intrinsic = Math.max(strike - spotAtExpiry, 0);
            }
            case SHORT_PUT -> {
                breakeven = strike - premium;
                maxRisk = strike - premium; // ASX's precise bounded formula, not Double.POSITIVE_INFINITY
                maxReward = premium;
                intrinsic = -Math.max(strike - spotAtExpiry, 0);
            }
            default -> throw new IllegalStateException("Unhandled position: " + position);
        }

        double payoff = Double.isNaN(spotAtExpiry)
            ? Double.NaN
            : (position == Position.LONG_CALL || position == Position.LONG_PUT ? intrinsic - premium : intrinsic + premium);

        return new Result(breakeven, maxRisk, maxReward, payoff);
    }
}
