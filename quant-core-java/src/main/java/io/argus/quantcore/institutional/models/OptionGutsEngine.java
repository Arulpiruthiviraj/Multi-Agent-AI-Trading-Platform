package io.argus.quantcore.institutional.models;

/**
 * Long/Short Guts - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Sections 2.24 and 2.27,
 * Eq. 91-95 and 106-110. A straddle variant using IN-the-money options at two different strikes
 * (K1 &lt; K2, an ITM call at K1 and an ITM put at K2) instead of a single ATM strike - more
 * expensive to establish (long) / more credit received (short) than a straddle, with
 * correspondingly different max-loss/max-profit math.
 */
public final class OptionGutsEngine {

    private OptionGutsEngine() {
    }

    public enum Position { LONG_GUTS, SHORT_GUTS }

    public record Result(
        double breakevenUpper, // S*up = K1 + premium
        double breakevenLower, // S*down = K2 - premium
        double maxProfit,
        double maxLoss
    ) {
    }

    /**
     * @param callStrike K1 (lower, the ITM call's strike).
     * @param putStrike  K2 (higher, the ITM put's strike); must exceed callStrike.
     * @param netPremium total premium paid (LONG_GUTS) or received (SHORT_GUTS) for both legs.
     * @return null if putStrike &lt;= callStrike, or (per the paper's own precondition) the net
     *         premium does not exceed the strike width - guts is only a genuine (non-arbitrage)
     *         trade when premium &gt; K2-K1.
     */
    public static Result evaluate(Position position, double callStrike, double putStrike, double netPremium) {
        if (callStrike <= 0 || putStrike <= callStrike) {
            return null;
        }
        double width = putStrike - callStrike;
        if (netPremium <= width) {
            return null;
        }
        double breakevenUpper = callStrike + netPremium;
        double breakevenLower = putStrike - netPremium;

        return position == Position.LONG_GUTS
            ? new Result(breakevenUpper, breakevenLower, Double.POSITIVE_INFINITY, netPremium - width)
            : new Result(breakevenUpper, breakevenLower, netPremium - width, Double.POSITIVE_INFINITY);
    }
}
