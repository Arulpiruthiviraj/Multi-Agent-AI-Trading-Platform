package io.argus.quantcore.institutional.models;

/**
 * Index cash-and-carry arbitrage - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section
 * 6.2, Eq. 421-422. Compares the observed index futures price to its theoretical cost-of-carry
 * fair value; a basis beyond transaction costs signals an arbitrage (sell rich futures + buy the
 * cash basket, or the reverse).
 */
public final class IndexCashAndCarryArbitrageEngine {

    private IndexCashAndCarryArbitrageEngine() {
    }

    public record Result(
        double fairFuturesPrice,
        double basis,
        String signal // SELL_FUTURES_BUY_CASH (rich), BUY_FUTURES_SELL_CASH (cheap), NEUTRAL
    ) {
    }

    /**
     * @param spotIndexLevel   S(t).
     * @param presentValueDividends D(t,T), PV of dividends paid by the underlying stocks through delivery.
     * @param riskFreeRate     r, assumed constant through delivery.
     * @param yearsToDelivery  T-t.
     * @param observedFuturesPrice F(t,T), the current market futures price.
     * @param transactionCostThreshold minimum |basis| (as a fraction of spot) required to call it
     *                          a real opportunity, not just noise - caller-supplied, not defaulted.
     * @return null if spotIndexLevel is not positive.
     */
    public static Result evaluate(double spotIndexLevel, double presentValueDividends, double riskFreeRate, double yearsToDelivery,
                                   double observedFuturesPrice, double transactionCostThreshold) {
        if (spotIndexLevel <= 0) {
            return null;
        }
        double fairPrice = (spotIndexLevel - presentValueDividends) * Math.exp(riskFreeRate * yearsToDelivery);
        double basis = (observedFuturesPrice - fairPrice) / spotIndexLevel;

        String signal = basis > transactionCostThreshold ? "SELL_FUTURES_BUY_CASH"
            : basis < -transactionCostThreshold ? "BUY_FUTURES_SELL_CASH"
            : "NEUTRAL";

        return new Result(fairPrice, basis, signal);
    }
}
