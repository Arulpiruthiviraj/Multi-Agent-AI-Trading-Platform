package io.argus.quantcore.institutional.models;

/**
 * Bond carry and roll-down - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Sections
 * 5.11-5.12, Eq. 413-415. Under the simplifying assumption that the term structure of interest
 * rates stays constant over the carry horizon (the paper's own assumption), total carry splits
 * into two pieces: the bond's own yield accrual (R(t,T)*deltaT) plus the "roll-down" gain from
 * the bond moving to a lower point on the (assumed-unchanged) yield curve as it ages
 * (Croll = -ModifiedDuration * [R(t,T-deltaT) - R(t,T)], Eq. 415). Section 5.12's own "rolling
 * down the yield curve" strategy targets this same Croll term directly - not a separate formula.
 */
public final class BondCarryEngine {

    private BondCarryEngine() {
    }

    public record Result(
        double yieldAccrual,
        double rollDown,
        double totalCarry
    ) {
    }

    /**
     * @param currentYield      R(t,T), the bond's current yield at its current maturity.
     * @param yieldAtShorterMaturity R(t,T-deltaT), the yield the (unchanged) curve currently
     *                          shows at the bond's maturity after the carry horizon elapses -
     *                          i.e. today's yield at the point on the curve this bond will occupy
     *                          once it has aged by deltaT.
     * @param modifiedDuration  the bond's modified duration (e.g. from BondDurationConvexityEngine).
     * @param deltaT            the carry horizon, in years.
     * @return null if deltaT is not positive.
     */
    public static Result evaluate(double currentYield, double yieldAtShorterMaturity, double modifiedDuration, double deltaT) {
        if (deltaT <= 0) {
            return null;
        }
        double yieldAccrual = currentYield * deltaT;
        double rollDown = -modifiedDuration * (yieldAtShorterMaturity - currentYield);
        return new Result(yieldAccrual, rollDown, yieldAccrual + rollDown);
    }
}
