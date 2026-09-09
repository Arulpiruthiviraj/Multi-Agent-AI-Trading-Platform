package io.argus.quantcore.institutional.models;

/**
 * Dollar carry trade - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 8.3, citing
 * Lustig, Roussanov &amp; Verdelhan, "Countercyclical Currency Risk Premia," J. Financial Economics
 * 2014. Distinct from the high-minus-low carry strategy (which longs/shorts a cross-sectional
 * spread): this goes long (short), with equal weights, ALL N foreign-currency forwards at once,
 * based only on the SIGN of the average cross-sectional forward discount D-bar(t,T) (Eq. 444).
 */
public final class FxDollarCarryEngine {

    private FxDollarCarryEngine() {
    }

    public record Result(
        double averageForwardDiscount,
        String signal // BUY (D-bar > 0, all long), SELL (D-bar < 0, all short), NEUTRAL (D-bar == 0)
    ) {
    }

    /**
     * @param forwardDiscountsByCurrency each currency's D_i(t,T) = ln(S_i) - ln(F_i) (Eq. 442-443).
     * @return null if the basket is empty.
     */
    public static Result evaluate(double[] forwardDiscountsByCurrency) {
        if (forwardDiscountsByCurrency == null || forwardDiscountsByCurrency.length == 0) {
            return null;
        }
        double sum = 0;
        for (double d : forwardDiscountsByCurrency) sum += d;
        double average = sum / forwardDiscountsByCurrency.length;

        String signal = average > 0 ? "BUY" : average < 0 ? "SELL" : "NEUTRAL";
        return new Result(average, signal);
    }
}
