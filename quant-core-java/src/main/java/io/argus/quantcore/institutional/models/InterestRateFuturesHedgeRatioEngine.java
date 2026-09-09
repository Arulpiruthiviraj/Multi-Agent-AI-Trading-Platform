package io.argus.quantcore.institutional.models;

/**
 * Interest rate futures hedge ratios - Kakushadze &amp; Serur, "151 Trading Strategies" (2018),
 * Section 10.1.2. Two distinct, fully-specified closed-form hedge ratios: the conversion factor
 * model (Eq. 467, h_C = C * M_B / M_F, for futures with a delivery basket and conversion factor -
 * e.g. T-bond/T-note futures) and the modified duration model (Eq. 468, h_D = beta * D_B / D_F,
 * usable for both deliverable and non-deliverable bonds). Pure arithmetic given caller-supplied
 * bond/futures notional and duration figures - no data feed dependency in the formula itself.
 */
public final class InterestRateFuturesHedgeRatioEngine {

    private InterestRateFuturesHedgeRatioEngine() {
    }

    /**
     * Conversion factor model (Eq. 467).
     *
     * @param conversionFactor C, the futures contract's conversion factor for the specific bond.
     * @param bondNotional     M_B, the nominal value of the bond position being hedged.
     * @param futuresNotional  M_F, the nominal value of one futures contract.
     * @return null if futuresNotional is not positive.
     */
    public static Double conversionFactorHedgeRatio(double conversionFactor, double bondNotional, double futuresNotional) {
        if (futuresNotional <= 0) {
            return null;
        }
        return conversionFactor * bondNotional / futuresNotional;
    }

    /**
     * Modified duration model (Eq. 468) - works for deliverable and non-deliverable bonds alike.
     *
     * @param yieldBetaFactor  beta, the change in bond yield relative to the change in futures
     *                         yield for a given change in the risk-free rate (often set to 1, per
     *                         the paper's own note - not defaulted here, caller decides).
     * @param bondDollarDuration    D_B, the bond's dollar duration (price * modified duration).
     * @param futuresDollarDuration D_F, the futures contract's dollar duration.
     * @return null if futuresDollarDuration is not positive.
     */
    public static Double modifiedDurationHedgeRatio(double yieldBetaFactor, double bondDollarDuration, double futuresDollarDuration) {
        if (futuresDollarDuration <= 0) {
            return null;
        }
        return yieldBetaFactor * bondDollarDuration / futuresDollarDuration;
    }
}
