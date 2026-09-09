package io.argus.quantcore.institutional.models;

/**
 * Stock + single-option combination strategies - cross-validated across Fidelity's "A Quick
 * Guide to Trading Options," the ASX "Understanding Options Trading" booklet, and Kakushadze &amp;
 * Serur, "151 Trading Strategies" (2018) Sections 2.2-2.5, Eq. 1-16: Covered Call (long stock +
 * short call), Covered Put (short stock + short put, Eq. 5-8), Protective Put / "married put"
 * (long stock + long put), Protective Call / "married call" (short stock + long call, Eq. 13-16),
 * and Collar (long stock + long put + short call).
 *
 * <p>Protective Put max-risk note: Fidelity gives the precise closed form (stockPrice - strike +
 * putPremium, independently re-derived here and confirmed exact: the combined payoff is provably
 * constant at strike-stockPrice-putPremium for every S at or below the strike, since the stock
 * loss and put gain move 1-for-1 below the strike). ASX's own text for the same strategy ("the
 * strike price plus the premium you paid") does not match this derivation and appears to be
 * loose/imprecise phrasing, similar to a discrepancy already noted in {@link
 * OptionButterflyEngine} - the rigorously re-derived, Fidelity-confirmed formula is used here.
 * Covered Put and Protective Call are the primary source's own symmetric mirror images of Covered
 * Call and Protective Put (Eq. 5-8 and 13-16 respectively) - transcribed directly.
 */
public final class OptionStockCombinationEngine {

    private OptionStockCombinationEngine() {
    }

    public enum Strategy { COVERED_CALL, COVERED_PUT, PROTECTIVE_PUT, PROTECTIVE_CALL, COLLAR }

    public record Result(
        double breakeven,
        double maxRisk,
        double maxReward
    ) {
    }

    /**
     * Covered Call: long stock + short call.
     *
     * @param stockPrice     price paid for the stock.
     * @param callStrike     strike of the short call.
     * @param callPremium    premium received for the short call.
     */
    public static Result coveredCall(double stockPrice, double callStrike, double callPremium) {
        if (stockPrice <= 0 || callStrike <= 0 || callPremium < 0) {
            return null;
        }
        double breakeven = stockPrice - callPremium;
        double maxRisk = breakeven; // bounded at S=0
        double maxReward = (callStrike - stockPrice) + callPremium;
        return new Result(breakeven, maxRisk, maxReward);
    }

    /**
     * Covered Put ("sell-write"): short stock + short put. Eq. 5-8 - the primary source's own
     * symmetric mirror of Covered Call.
     *
     * @param stockPrice price at which stock was shorted.
     * @param putStrike  strike of the short put.
     * @param putPremium premium received for the short put.
     */
    public static Result coveredPut(double stockPrice, double putStrike, double putPremium) {
        if (stockPrice <= 0 || putStrike <= 0 || putPremium < 0) {
            return null;
        }
        double breakeven = stockPrice + putPremium;
        double maxReward = stockPrice - putStrike + putPremium;
        return new Result(breakeven, Double.POSITIVE_INFINITY, maxReward);
    }

    /**
     * Protective Call ("married call"): short stock + long call, strike K &gt;= stockPrice.
     * Eq. 13-16 - the primary source's own symmetric mirror of Protective Put.
     *
     * @param stockPrice price at which stock was shorted.
     * @param callStrike strike of the long call.
     * @param callPremium premium paid for the long call.
     */
    public static Result protectiveCall(double stockPrice, double callStrike, double callPremium) {
        if (stockPrice <= 0 || callStrike <= 0 || callPremium < 0) {
            return null;
        }
        double breakeven = stockPrice - callPremium;
        double maxReward = stockPrice - callPremium; // Pmax = S0 - D, per Eq. 15
        double maxRisk = callStrike - stockPrice + callPremium;
        return new Result(breakeven, maxRisk, maxReward);
    }

    /**
     * Protective Put ("married put"): long stock + long put.
     *
     * @param stockPrice price paid for the stock.
     * @param putStrike  strike of the long put.
     * @param putPremium premium paid for the long put.
     */
    public static Result protectivePut(double stockPrice, double putStrike, double putPremium) {
        if (stockPrice <= 0 || putStrike <= 0 || putPremium < 0) {
            return null;
        }
        double breakeven = stockPrice + putPremium;
        double maxRisk = stockPrice - putStrike + putPremium;
        return new Result(breakeven, maxRisk, Double.POSITIVE_INFINITY);
    }

    /**
     * Collar: long stock + long put (lower strike) + short call (higher strike).
     *
     * @param stockPrice price paid for the stock.
     * @param putStrike  strike of the long put; must be below callStrike.
     * @param callStrike strike of the short call.
     * @param netPremium signed: positive = net credit (call premium received exceeds put premium
     *                   paid), negative = net debit.
     */
    public static Result collar(double stockPrice, double putStrike, double callStrike, double netPremium) {
        if (stockPrice <= 0 || putStrike <= 0 || callStrike <= putStrike) {
            return null;
        }
        double breakeven = stockPrice - netPremium;
        double maxReward = callStrike - stockPrice + netPremium;
        double maxRisk = stockPrice - putStrike - netPremium;
        return new Result(breakeven, maxRisk, maxReward);
    }
}
