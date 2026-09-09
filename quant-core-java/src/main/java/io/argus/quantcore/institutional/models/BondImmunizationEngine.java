package io.argus.quantcore.institutional.models;

import io.argus.quantcore.institutional.math.Matrix;

/**
 * Bond immunization against a future cash obligation - Kakushadze &amp; Serur, "151 Trading
 * Strategies" (2018), Section 5.5, Eq. 396-403. Builds a bond portfolio whose duration (2-bond
 * system) or duration AND convexity (3-bond system) matches a target cash obligation's maturity,
 * protecting it against parallel yield-curve shifts. The 2-bond case is solved in closed form; the
 * 3-bond case reuses the existing Matrix.invert linear solver rather than a new one.
 */
public final class BondImmunizationEngine {

    private BondImmunizationEngine() {
    }

    /** Eq. 396: required initial investment given a future obligation F, its maturity T*, yield Y, and compounding period delta. */
    public static double requiredInvestment(double futureObligation, double obligationMaturityYears, double yieldPerPeriod, double periodLength) {
        double periods = obligationMaturityYears / periodLength;
        return futureObligation / Math.pow(1 + yieldPerPeriod * periodLength, periods);
    }

    /** Eq. 399: target portfolio duration D = T* / (1 + Y*delta). */
    public static double targetDuration(double obligationMaturityYears, double yieldPerPeriod, double periodLength) {
        return obligationMaturityYears / (1 + yieldPerPeriod * periodLength);
    }

    /** Eq. 403: target portfolio convexity C = T*(T*+delta) / (1 + Y*delta)^2. */
    public static double targetConvexity(double obligationMaturityYears, double yieldPerPeriod, double periodLength) {
        double denom = 1 + yieldPerPeriod * periodLength;
        return obligationMaturityYears * (obligationMaturityYears + periodLength) / (denom * denom);
    }

    public record TwoBondAllocation(double dollarsInBond1, double dollarsInBond2) {
    }

    /**
     * Eq. 397-398: 2-bond duration-matching system. P1+P2=P, P1*D1+P2*D2=P*D.
     *
     * @return null if duration1 equals duration2 (the system is singular - the two bonds provide
     *         no independent duration information).
     */
    public static TwoBondAllocation solveTwoBond(double totalInvestment, double targetDuration, double duration1, double duration2) {
        if (duration1 == duration2) {
            return null;
        }
        double dollars1 = totalInvestment * (duration2 - targetDuration) / (duration2 - duration1);
        double dollars2 = totalInvestment - dollars1;
        return new TwoBondAllocation(dollars1, dollars2);
    }

    public record ThreeBondAllocation(double dollarsInBond1, double dollarsInBond2, double dollarsInBond3) {
    }

    /**
     * Eq. 400-402: 3-bond duration-AND-convexity-matching system, solved as a real 3x3 linear
     * system (reusing Matrix.invert, not a new solver): P1+P2+P3=P; P1*D1+P2*D2+P3*D3=P*D;
     * P1*C1+P2*C2+P3*C3=P*C.
     *
     * @return null if the 3x3 system is singular (the three bonds' duration/convexity profiles
     *         don't span the target - Matrix.invert's own null-on-singular contract).
     */
    public static ThreeBondAllocation solveThreeBond(double totalInvestment, double targetDuration, double targetConvexity,
                                                        double duration1, double duration2, double duration3,
                                                        double convexity1, double convexity2, double convexity3) {
        double[][] a = {
            {1, 1, 1},
            {duration1, duration2, duration3},
            {convexity1, convexity2, convexity3}
        };
        double[][] inv = Matrix.invert(a);
        if (inv == null) {
            return null;
        }
        double[] b = {totalInvestment, totalInvestment * targetDuration, totalInvestment * targetConvexity};
        double[] p = Matrix.multiply(inv, b);
        return new ThreeBondAllocation(p[0], p[1], p[2]);
    }
}
