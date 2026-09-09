package io.argus.quantcore.institutional.models;

/**
 * Bull/Bear Call/Put Ladders - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Sections
 * 2.14-2.17, Eq. 53-72. A 3-leg vertical extension: a two-leg spread with a THIRD leg added at a
 * further-out strike, financed by/financing the original spread. Bull Call Ladder = long K1 call +
 * short K2 call + short K3 call (net debit): converts a bull call spread's capped upside into
 * unlimited risk beyond K3, in exchange for extra income if the stock stays below K3. Formulas
 * transcribed directly from the paper's own closed forms (verified internally consistent: e.g.
 * Bull Call Ladder's Pmax = K2-K1-H exactly matches the underlying bull call spread's own Pmax,
 * confirming the third leg only changes the payoff ABOVE K3, not the core spread's own profit
 * zone).
 */
public final class OptionLadderEngine {

    private OptionLadderEngine() {
    }

    public enum LadderType { BULL_CALL_LADDER, BULL_PUT_LADDER, BEAR_CALL_LADDER, BEAR_PUT_LADDER }

    public record Result(
        double breakevenLower,
        double breakevenUpper,
        double maxProfit,
        double maxLoss // Double.POSITIVE_INFINITY where the paper's own formula is "unlimited"
    ) {
    }

    /**
     * @param strike1, strike2, strike3 K1 &lt; K2 &lt; K3 (BULL_CALL_LADDER, BEAR_PUT_LADDER) or the
     *                 paper's own analogous ordering for the other two variants - always supplied
     *                 as the three ascending strikes K1&lt;K2&lt;K3 regardless of which leg is which
     *                 (long/short is determined by ladderType, not by strike order).
     * @param netPremium H: net debit paid (BULL_CALL_LADDER, BEAR_PUT_LADDER) or net credit
     *                   received (BULL_PUT_LADDER, BEAR_CALL_LADDER), as a signed value matching
     *                   the paper's own H convention (positive H in the paper's formulas below).
     * @return null if strikes are not strictly ascending.
     */
    public static Result evaluate(LadderType ladderType, double strike1, double strike2, double strike3, double netPremium) {
        if (strike1 <= 0 || strike2 <= strike1 || strike3 <= strike2) {
            return null;
        }
        double k1 = strike1, k2 = strike2, k3 = strike3, h = netPremium;

        return switch (ladderType) {
            // Eq. 53-57: long K1 call, short K2 call, short K3 call, net debit H.
            case BULL_CALL_LADDER -> new Result(k1 + h, k3 + k2 - k1 - h, k2 - k1 - h, Double.POSITIVE_INFINITY);
            // Eq. 58-62: short K1 put, long K2 put, long K3 put, net debit H (paper's H<0 convention for this variant).
            case BULL_PUT_LADDER -> new Result(k1 + h, k3 + k2 - k1 - h, k3 + k2 - k1 - h, k1 - k2 + h);
            // Eq. 63-67: short K1 call, long K2 call, long K3 call, net debit H (paper's H<0 convention).
            case BEAR_CALL_LADDER -> new Result(k1 - h, k3 + k2 - k1 + h, Double.POSITIVE_INFINITY, k2 - k1 + h);
            // Eq. 68-72: long K1 put, short K2 put, short K3 put, net credit H.
            case BEAR_PUT_LADDER -> new Result(k1 - h, k3 + k2 - k1 + h, k1 - k2 - h, k3 + k2 - k1 + h);
        };
    }
}
