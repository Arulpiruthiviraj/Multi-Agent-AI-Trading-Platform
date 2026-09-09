package io.argus.quantcore.institutional.models;

/**
 * Synthetic straddles built from stock + 2x ATM options - Kakushadze &amp; Serur, "151 Trading
 * Strategies" (2018), Sections 2.28-2.31, Eq. 111-130. These replicate a long/short straddle's
 * payoff shape using a stock position plus a 2:1 ratio of one option type, instead of one call and
 * one put. Distinct from {@link OptionStrapStripEngine} (which is 2 calls + 1 put, or 1 call + 2
 * puts, no stock leg) and from {@link OptionSyntheticStockEngine} (1 call + 1 put, no ratio).
 */
public final class OptionSyntheticStraddleEngine {

    private OptionSyntheticStraddleEngine() {
    }

    public enum Position { LONG_CALL_SYNTHETIC, LONG_PUT_SYNTHETIC, SHORT_CALL_SYNTHETIC, SHORT_PUT_SYNTHETIC }

    public record Result(
        double breakevenUpper,
        double breakevenLower,
        double maxProfit,
        double maxLoss
    ) {
    }

    /**
     * @param stockPrice S0, the price stock was bought/sold at.
     * @param strike     K, the common ATM strike of both options.
     * @param netPremium total premium paid (LONG_ variants, must exceed |S0-K| per the paper's
     *                   own precondition - otherwise risk-free arbitrage) or received (SHORT_
     *                   variants).
     * @return null if stockPrice or strike is not positive, or (for LONG_ variants) netPremium
     *         does not exceed |S0-K|.
     */
    public static Result evaluate(Position position, double stockPrice, double strike, double netPremium) {
        if (stockPrice <= 0 || strike <= 0) {
            return null;
        }
        double intrinsicGap = Math.abs(stockPrice - strike);

        return switch (position) {
            case LONG_CALL_SYNTHETIC -> {
                if (netPremium <= intrinsicGap) yield null;
                yield new Result(2 * strike - stockPrice + netPremium, stockPrice - netPremium,
                    Double.POSITIVE_INFINITY, netPremium - (stockPrice - strike));
            }
            case LONG_PUT_SYNTHETIC -> {
                if (netPremium <= intrinsicGap) yield null;
                yield new Result(stockPrice + netPremium, 2 * strike - stockPrice - netPremium,
                    Double.POSITIVE_INFINITY, netPremium - (strike - stockPrice));
            }
            case SHORT_CALL_SYNTHETIC -> new Result(2 * strike - stockPrice + netPremium, stockPrice - netPremium,
                strike - stockPrice + netPremium, Double.POSITIVE_INFINITY);
            case SHORT_PUT_SYNTHETIC -> new Result(stockPrice + netPremium, 2 * strike - stockPrice - netPremium,
                stockPrice - strike + netPremium, Double.POSITIVE_INFINITY);
        };
    }
}
