package io.argus.quantcore.institutional.models;

/**
 * Bond duration and convexity - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section
 * 5.1.5, Eq. 384-389. Foundational risk measures several other bond strategies in this catalog
 * (barbell, immunization, butterfly, carry) build on directly. Macaulay duration is the
 * present-value-weighted average maturity of a bond's cash flows; modified duration measures
 * relative price sensitivity to parallel yield-curve shifts; dollar duration measures absolute
 * (dollar) price sensitivity; convexity captures the second-order (nonlinear) correction to the
 * price-sensitivity approximation (Eq. 389).
 */
public final class BondDurationConvexityEngine {

    private BondDurationConvexityEngine() {
    }

    public record CashFlow(double timeFromNow, double presentValue) {
    }

    public record Result(
        double macaulayDuration,
        double modifiedDuration,
        double dollarDuration,
        double bondPrice
    ) {
    }

    /**
     * Eq. 384: Macaulay duration as the PV-weighted average time of the bond's cash flows;
     * Eq. 386: modified duration under periodic compounding at yield Y and period length delta
     * (ModD = MacD / (1 + Y*delta)); Eq. 387: dollar duration = ModD * bondPrice.
     *
     * @param cashFlows each remaining cash flow's time-from-now and present value (caller
     *                  computes the discounting - this class does not invent a discount curve).
     * @param yieldPerPeriod Y, the periodic-compounding yield.
     * @param periodLength   delta, the compounding period length in years (e.g. 1.0 for annual,
     *                       0.5 for semiannual). Pass 0 (with yieldPerPeriod irrelevant) for
     *                       continuous compounding, in which case modified duration equals
     *                       Macaulay duration exactly (per the paper's own note).
     * @return null if no cash flows are supplied, or total present value is zero.
     */
    public static Result evaluate(CashFlow[] cashFlows, double yieldPerPeriod, double periodLength) {
        if (cashFlows == null || cashFlows.length == 0) {
            return null;
        }
        double totalPv = 0;
        double weightedTime = 0;
        for (CashFlow cf : cashFlows) {
            totalPv += cf.presentValue();
            weightedTime += cf.timeFromNow() * cf.presentValue();
        }
        if (totalPv == 0) {
            return null;
        }
        double macaulay = weightedTime / totalPv;
        double modified = periodLength == 0 ? macaulay : macaulay / (1 + yieldPerPeriod * periodLength);
        double dollarDuration = modified * totalPv;

        return new Result(macaulay, modified, dollarDuration, totalPv);
    }

    /**
     * Eq. 389: second-order price-change approximation given modified duration, convexity, and a
     * parallel yield change deltaR (positive = yields rise).
     */
    public static double approximatePriceChangePct(double modifiedDuration, double convexity, double deltaR) {
        return -modifiedDuration * deltaR + 0.5 * convexity * deltaR * deltaR;
    }

    /**
     * Eq. 388: convexity from a 3-point finite-difference second derivative of price w.r.t. yield -
     * given bond prices at yield-Y, yield, and yield+Y for a small bump size bumpSize (not the
     * paper's own closed-form Eq. 388 itself, which requires an analytical price function; this is
     * the standard numerical estimate used when only discrete re-pricings are available).
     *
     * @return null if bumpSize or priceAtYield is not positive.
     */
    public static Double approximateConvexity(double priceAtYieldMinusBump, double priceAtYield, double priceAtYieldPlusBump, double bumpSize) {
        if (bumpSize <= 0 || priceAtYield <= 0) {
            return null;
        }
        double secondDerivative = (priceAtYieldPlusBump - 2 * priceAtYield + priceAtYieldMinusBump) / (bumpSize * bumpSize);
        return secondDerivative / priceAtYield;
    }
}
