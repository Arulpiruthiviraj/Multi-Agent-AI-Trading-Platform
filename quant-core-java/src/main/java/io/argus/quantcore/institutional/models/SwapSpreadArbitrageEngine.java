package io.argus.quantcore.institutional.models;

/**
 * Swap-spread arbitrage - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 5.15,
 * Eq. 418-420. A dollar-neutral long (short) interest-rate swap vs. short (long) Treasury bond of
 * the same maturity. Per-dollar P&amp;L rate is the difference between the swap-vs-Treasury spread
 * (C1, fixed at trade inception) and the LIBOR-vs-repo funding spread (C2, which varies over
 * time) - effectively a bet on whether LIBOR falls (long swap, profits) or rises (short swap).
 */
public final class SwapSpreadArbitrageEngine {

    private SwapSpreadArbitrageEngine() {
    }

    /** Eq. 419: C1 = rswap - YTreasury, fixed at trade inception. */
    public static double initialSpread(double swapFixedRate, double treasuryYield) {
        return swapFixedRate - treasuryYield;
    }

    /** Eq. 420: C2(t) = L(t) - r(t), the time-varying LIBOR-vs-repo funding spread. */
    public static double fundingSpread(double liborRate, double repoRate) {
        return liborRate - repoRate;
    }

    /**
     * Eq. 418: per-dollar P&amp;L rate. isLongSwap = true for a long-swap/short-Treasury position
     * (profits if LIBOR falls, i.e. C2 shrinks), false for the opposite (short-swap/long-Treasury).
     */
    public static double pnlRate(double initialSpread, double currentFundingSpread, boolean isLongSwap) {
        double diff = initialSpread - currentFundingSpread;
        return isLongSwap ? diff : -diff;
    }
}
