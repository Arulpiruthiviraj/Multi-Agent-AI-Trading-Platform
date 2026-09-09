package io.argus.quantcore.institutional.models;

/**
 * Intraday arbitrage between two ETFs tracking the same index - Kakushadze &amp; Serur, "151
 * Trading Strategies" (2018), Section 6.4, Eq. 428. A pure bid/ask crossing rule: if one ETF's
 * bid exceeds the other's ask by more than a threshold kappa (close to 1, e.g. 1.002), buy the
 * cheap one and short the rich one.
 */
public final class IndexEtfArbitrageEngine {

    private IndexEtfArbitrageEngine() {
    }

    public enum Action { BUY_ETF2_SHORT_ETF1, BUY_ETF1_SHORT_ETF2, LIQUIDATE, NONE }

    /**
     * @param bid1, ask1 ETF1's current bid/ask.
     * @param bid2, ask2 ETF2's current bid/ask.
     * @param kappa      the crossing threshold, e.g. 1.002; caller-supplied, not defaulted.
     * @param currentlyLongEtf2ShortEtf1 whether a BUY_ETF2_SHORT_ETF1 position is currently open
     *                   (needed to evaluate the liquidation rule, which is a different crossing
     *                   condition than the entry rule).
     * @param currentlyLongEtf1ShortEtf2 whether the opposite position is currently open.
     */
    public static Action evaluate(double bid1, double ask1, double bid2, double ask2, double kappa,
                                   boolean currentlyLongEtf2ShortEtf1, boolean currentlyLongEtf1ShortEtf2) {
        if (currentlyLongEtf2ShortEtf1 && bid2 >= ask1) {
            return Action.LIQUIDATE;
        }
        if (currentlyLongEtf1ShortEtf2 && bid1 >= ask2) {
            return Action.LIQUIDATE;
        }
        if (bid1 >= ask2 * kappa) {
            return Action.BUY_ETF2_SHORT_ETF1;
        }
        if (bid2 >= ask1 * kappa) {
            return Action.BUY_ETF1_SHORT_ETF2;
        }
        return Action.NONE;
    }
}
