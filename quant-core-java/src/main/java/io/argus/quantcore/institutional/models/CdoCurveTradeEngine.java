package io.argus.quantcore.institutional.models;

/**
 * CDO tranche curve trade - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 11.6,
 * Eq. 490-491. A flattener (steepener) simultaneously sells (buys) a short-term tranche and buys
 * (sells) a long-term tranche, betting the spread curve flattens (steepens). Carry over a period is
 * (M_long*S_long - M_short*S_short)*deltaT (Eq. 490); realized P&amp;L is the change in the two
 * tranches' own mark-to-market values (Eq. 491), each computed by CdoTrancheWaterfallEngine.
 */
public final class CdoCurveTradeEngine {

    private CdoCurveTradeEngine() {
    }

    /**
     * Eq. 490: carry of the curve trade over [t, t+deltaT].
     *
     * @param longTrancheNotional  M_long
     * @param longTrancheSpread    S_long
     * @param shortTrancheNotional M_short
     * @param shortTrancheSpread   S_short
     * @param yearFraction         deltaT, the period length in years.
     */
    public static double carry(double longTrancheNotional, double longTrancheSpread, double shortTrancheNotional, double shortTrancheSpread, double yearFraction) {
        return (longTrancheNotional * longTrancheSpread - shortTrancheNotional * shortTrancheSpread) * yearFraction;
    }

    /**
     * Eq. 491: realized P&amp;L, the difference between the long and short tranches' own
     * mark-to-market values (each from CdoTrancheWaterfallEngine.evaluate()).
     */
    public static double profitAndLoss(double longTrancheMarkToMarket, double shortTrancheMarkToMarket) {
        return longTrancheMarkToMarket - shortTrancheMarkToMarket;
    }
}
