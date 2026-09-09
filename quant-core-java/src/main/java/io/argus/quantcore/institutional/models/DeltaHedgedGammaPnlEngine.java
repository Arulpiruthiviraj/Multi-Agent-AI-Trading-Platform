package io.argus.quantcore.institutional.models;

/**
 * Delta-hedged gamma P&amp;L approximation - the standard result (see e.g. Hull, "Options, Futures,
 * and Other Derivatives") that a continuously delta-hedged option position's P&amp;L over a short
 * interval dt is approximately (1/2) * Gamma * S^2 * (sigma_realized^2 - sigma_implied^2) * dt.
 * This is the mechanism behind "volatility risk premium" harvesting strategies (short gamma,
 * profiting when realized vol comes in below the implied vol the position was sold at) and gamma
 * scalping (long gamma, profiting when realized exceeds implied) - the same formula, opposite
 * sign of Gamma. Gamma itself should come from BlackScholesEngine.
 */
public final class DeltaHedgedGammaPnlEngine {

    private DeltaHedgedGammaPnlEngine() {
    }

    /**
     * @param gamma            the position's net Gamma (negative for a net-short-options
     *                         delta-hedged position, positive for net-long).
     * @param spot             S, the underlying price.
     * @param realizedVolatility annualized realized volatility over the interval.
     * @param impliedVolatility  annualized implied volatility the position was transacted at.
     * @param dtYears         the interval length, in years (e.g. 1/365 for one day).
     * @return the approximate P&amp;L over the interval; null if spot is not positive or dtYears
     *         is not positive.
     */
    public static Double approximatePnl(double gamma, double spot, double realizedVolatility, double impliedVolatility, double dtYears) {
        if (spot <= 0 || dtYears <= 0) {
            return null;
        }
        return 0.5 * gamma * spot * spot * (realizedVolatility * realizedVolatility - impliedVolatility * impliedVolatility) * dtYears;
    }
}
