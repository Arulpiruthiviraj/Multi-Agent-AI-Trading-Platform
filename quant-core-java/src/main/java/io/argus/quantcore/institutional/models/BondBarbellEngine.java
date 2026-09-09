package io.argus.quantcore.institutional.models;

/**
 * Barbell vs. bullet bond portfolio comparison - Kakushadze &amp; Serur, "151 Trading Strategies"
 * (2018), Section 5.3, Eq. 390-394. A barbell (short-maturity T1 + long-maturity T2 zero-coupon
 * bonds) has the SAME duration as a mid-maturity bullet, but strictly HIGHER convexity - the real
 * quantitative edge behind the strategy. Eq. 394's closed form for that convexity gap was
 * independently re-derived by hand (straightforward algebra per the paper's own note) and matches
 * exactly: C - C* = [w1*w2 / (w1+w2)^2] * (T2-T1)^2, always positive.
 */
public final class BondBarbellEngine {

    private BondBarbellEngine() {
    }

    public record Result(
        double barbellDuration,       // D, Eq. 390
        double bulletMaturity,        // T* = D* = D, Eq. 391
        double barbellConvexity,      // C, Eq. 392
        double bulletConvexity,       // C*, Eq. 393
        double convexityAdvantage     // C - C*, Eq. 394, always > 0
    ) {
    }

    /**
     * @param shortMaturityDollars  w1, dollars invested in the short-maturity (T1) zero-coupon bond.
     * @param shortMaturityYears    T1.
     * @param longMaturityDollars   w2, dollars invested in the long-maturity (T2) zero-coupon bond.
     * @param longMaturityYears     T2; must exceed shortMaturityYears.
     * @param yield                 Y, the constant continuously-compounded yield assumed for both bonds.
     * @return null if maturities are not properly ordered, or both dollar amounts are zero.
     */
    public static Result evaluate(double shortMaturityDollars, double shortMaturityYears, double longMaturityDollars, double longMaturityYears, double yield) {
        if (longMaturityYears <= shortMaturityYears || shortMaturityYears < 0) {
            return null;
        }
        if (shortMaturityDollars + longMaturityDollars == 0) {
            return null;
        }
        // w-bar_i = w_i * exp(-T_i * Y), the PV-weighted amounts used in Eq. 390/392.
        double wBar1 = shortMaturityDollars * Math.exp(-shortMaturityYears * yield);
        double wBar2 = longMaturityDollars * Math.exp(-longMaturityYears * yield);
        double totalWBar = wBar1 + wBar2;
        if (totalWBar == 0) {
            return null;
        }

        double duration = (wBar1 * shortMaturityYears + wBar2 * longMaturityYears) / totalWBar;
        double bulletMaturity = duration; // T* = D* = D, Eq. 391
        double convexity = (wBar1 * shortMaturityYears * shortMaturityYears + wBar2 * longMaturityYears * longMaturityYears) / totalWBar;
        double bulletConvexity = bulletMaturity * bulletMaturity; // C* = T*^2, Eq. 393
        double convexityAdvantage = (wBar1 * wBar2 / (totalWBar * totalWBar)) * (longMaturityYears - shortMaturityYears) * (longMaturityYears - shortMaturityYears);

        return new Result(duration, bulletMaturity, convexity, bulletConvexity, convexityAdvantage);
    }
}
