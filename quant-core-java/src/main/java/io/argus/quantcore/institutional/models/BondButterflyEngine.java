package io.argus.quantcore.institutional.models;

/**
 * Bond butterfly (barbell wings + short bullet body) allocation - Kakushadze &amp; Serur, "151
 * Trading Strategies" (2018), Sections 5.6-5.8.1, Eq. 404-409. Four variants sharing the same
 * dollar-duration-neutrality idea but differing in how the wing allocation (P1, wing 1, vs P3,
 * wing 3) is split relative to the short body position P2:
 * <ul>
 * <li>dollar-duration-neutral: ALSO dollar-neutral (P1+P3=P2, P1*D1+P3*D3=P2*D2) - a genuine
 *     zero-cost trade, immune to parallel yield shifts.</li>
 * <li>fifty-fifty ("neutral curve"): NOT dollar-neutral; instead each wing carries equal dollar
 *     duration (P1*D1 = P3*D3 = P2*D2/2) - approximately neutral to small steepening/flattening.</li>
 * <li>regression-weighted: dollar-duration-neutral, but the wing split ratio beta = P1*D1/(P3*D3)
 *     comes from an external historical regression of spread changes (caller-supplied - this
 *     class does not fit it).</li>
 * <li>maturity-weighted: same shape as regression-weighted, but beta is fixed purely from the 3
 *     maturities (Eq. 409: beta = (T2-T1)/(T3-T2)) rather than a fitted coefficient.</li>
 * </ul>
 */
public final class BondButterflyEngine {

    private BondButterflyEngine() {
    }

    public record WingAllocation(double dollarsInWing1, double dollarsInWing3) {
    }

    /**
     * Eq. 404-405: dollar-duration-neutral AND dollar-neutral (P1+P3=P2, P1*D1+P3*D3=P2*D2).
     *
     * @return null if duration1 equals duration3 (the 2x2 system is singular).
     */
    public static WingAllocation dollarDurationNeutral(double bodyDollars, double bodyDuration, double duration1, double duration3) {
        if (duration3 == duration1) {
            return null;
        }
        double dollars1 = bodyDollars * (duration3 - bodyDuration) / (duration3 - duration1);
        double dollars3 = bodyDollars - dollars1;
        return new WingAllocation(dollars1, dollars3);
    }

    /** Eq. 406: fifty-fifty ("neutral curve") - equal dollar duration on each wing, NOT dollar-neutral. */
    public static WingAllocation fiftyFifty(double bodyDollars, double bodyDuration, double duration1, double duration3) {
        if (duration1 <= 0 || duration3 <= 0) {
            return null;
        }
        double targetWingDollarDuration = bodyDollars * bodyDuration / 2.0;
        return new WingAllocation(targetWingDollarDuration / duration1, targetWingDollarDuration / duration3);
    }

    /**
     * Eq. 407-408: regression-weighted - dollar-duration-neutral, with the wing split ratio
     * beta = (P1*D1) / (P3*D3) supplied by the caller (from an external regression).
     *
     * @return null if duration1, duration3, or (beta+1) is not positive.
     */
    public static WingAllocation regressionWeighted(double bodyDollars, double bodyDuration, double duration1, double duration3, double beta) {
        if (duration1 <= 0 || duration3 <= 0 || beta + 1 <= 0) {
            return null;
        }
        double dollars3 = bodyDollars * bodyDuration / (duration3 * (beta + 1));
        double dollars1 = beta * bodyDollars * bodyDuration / (duration1 * (beta + 1));
        return new WingAllocation(dollars1, dollars3);
    }

    /** Eq. 409: maturity-weighted - same shape as regressionWeighted, with beta = (T2-T1)/(T3-T2) fixed from maturities alone. */
    public static WingAllocation maturityWeighted(double bodyDollars, double bodyDuration, double duration1, double duration3,
                                                    double maturity1, double maturity2, double maturity3) {
        if (maturity3 <= maturity2) {
            return null;
        }
        double beta = (maturity2 - maturity1) / (maturity3 - maturity2);
        return regressionWeighted(bodyDollars, bodyDuration, duration1, duration3, beta);
    }
}
