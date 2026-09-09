package io.argus.quantcore.institutional.models;

/**
 * Modified Call/Put Butterfly - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Sections
 * 2.40.1 and 2.41.1, Eq. 173-176 and 182-185. A standard butterfly (see {@link
 * OptionButterflyEngine}) whose strikes are deliberately NOT equidistant - K1-K2 &lt; K2-K3 for
 * calls, K3-K2 &lt; K2-K1 for puts - giving the sideways strategy a directional (bullish) bias
 * instead of the symmetric standard butterfly's neutral profile.
 */
public final class OptionModifiedButterflyEngine {

    private OptionModifiedButterflyEngine() {
    }

    public record CallResult(
        double breakeven, // single breakeven: K3 + netDebit
        double maxProfit, // K2 - K3 - netDebit
        double maxLoss    // = netDebit
    ) {
    }

    /**
     * Eq. 173-176: long K1 call (lowest), short 2x K2 call, long K3 call (highest), with
     * K1-K2 &lt; K2-K3 (non-equidistant), net debit paid.
     *
     * @return null if strikes are not properly ordered (K1 &lt; K2 &lt; K3) or non-equidistant as required.
     */
    public static CallResult evaluateModifiedCallButterfly(double strike1, double strike2, double strike3, double netDebit) {
        if (strike1 <= 0 || strike2 <= strike1 || strike3 <= strike2) {
            return null;
        }
        if ((strike2 - strike1) >= (strike3 - strike2)) {
            return null; // must be non-equidistant in the paper's own direction
        }
        return new CallResult(strike3 + netDebit, strike2 - strike3 - netDebit, netDebit);
    }

    public record PutResult(
        double breakevenLower, // 2*K2 - K3 + netPremium
        Double breakevenUpper, // K3 - netPremium, only defined when netPremium > 0 per the paper's own note
        double maxProfit,      // K3 - K2 - netPremium
        double maxLoss         // 2*K2 - K1 - K3 + netPremium
    ) {
    }

    /**
     * Eq. 182-185: long K1 put (lowest), short 2x K2 put, long K3 put (highest), with
     * K3-K2 &lt; K2-K1 (non-equidistant). netPremium is signed (positive = net credit received,
     * negative = net debit paid) per the paper's own H convention for this specific strategy.
     *
     * @return null if strikes are not properly ordered or non-equidistant as required.
     */
    public static PutResult evaluateModifiedPutButterfly(double strike1, double strike2, double strike3, double netPremium) {
        if (strike1 <= 0 || strike2 <= strike1 || strike3 <= strike2) {
            return null;
        }
        if ((strike3 - strike2) >= (strike2 - strike1)) {
            return null;
        }
        double breakevenLower = 2 * strike2 - strike3 + netPremium;
        Double breakevenUpper = netPremium > 0 ? strike3 - netPremium : null;
        double maxProfit = strike3 - strike2 - netPremium;
        double maxLoss = 2 * strike2 - strike1 - strike3 + netPremium;
        return new PutResult(breakevenLower, breakevenUpper, maxProfit, maxLoss);
    }
}
