package io.argus.quantcore.institutional.models;

/**
 * Stock + single-option combination strategies - cross-validated across Fidelity's "A Quick
 * Guide to Trading Options" and the ASX "Understanding Options Trading" booklet: Covered Call
 * (long stock + short call), Protective Put / "married put" (long stock + long put), and Collar
 * (long stock + long put + short call).
 *
 * <p>Protective Put max-risk note: Fidelity gives the precise closed form (stockPrice - strike +
 * putPremium, independently re-derived here and confirmed exact: the combined payoff is provably
 * constant at strike-stockPrice-putPremium for every S at or below the strike, since the stock
 * loss and put gain move 1-for-1 below the strike). ASX's own text for the same strategy ("the
 * strike price plus the premium you paid") does not match this derivation and appears to be
 * loose/imprecise phrasing, similar to a discrepancy already noted in {@link
 * OptionButterflyEngine} - the rigorously re-derived, Fidelity-confirmed formula is used here.
 */
public final class OptionStockCombinationEngine {

    private OptionStockCombinationEngine() {
    }

    public enum Strategy { COVERED_CALL, PROTECTIVE_PUT, COLLAR }

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
