package io.argus.quantcore.institutional.models;

/**
 * Single-currency FX carry trade - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section
 * 8.2. Pursuant to Covered Interest Rate Parity (CIRP, Eq. 441), F(t,T) = S(t) * (1+rd)/(1+rf).
 * The paper's own basic carry rule: sell (write) forwards on currencies at a forward premium
 * (F &gt; S), buy forwards on currencies at a forward discount (F &lt; S) - this is not a risk-free
 * arbitrage (Eq. 441 is itself the no-arbitrage condition CIRP imposes); the risk is genuine FX-rate
 * exposure on the unhedged position (distinct from the risk-free hedged variant the paper also
 * describes, which is out of scope here - that's arbitrage bookkeeping, not a directional signal).
 */
public final class FxCarryTradeEngine {

    private FxCarryTradeEngine() {
    }

    public record Result(
        double forwardRate,
        double spotRate,
        double forwardPremiumOrDiscount, // (F - S) / S; positive = premium, negative = discount
        String signal // BUY (discount, F < S), SELL (premium, F > S), NEUTRAL (F == S)
    ) {
    }

    /**
     * @param spotRate   S(t), the current spot FX rate (domestic currency per unit of foreign).
     * @param forwardRate F(t,T), the forward FX rate for the same currency pair and maturity T.
     * @return null if spotRate is not positive.
     */
    public static Result evaluate(double spotRate, double forwardRate) {
        if (spotRate <= 0 || Double.isNaN(spotRate) || Double.isNaN(forwardRate)) {
            return null;
        }
        double premiumOrDiscount = (forwardRate - spotRate) / spotRate;
        String signal = forwardRate > spotRate ? "SELL" : forwardRate < spotRate ? "BUY" : "NEUTRAL";
        return new Result(forwardRate, spotRate, premiumOrDiscount, signal);
    }

    /**
     * Overload deriving F(t,T) from CIRP (Eq. 441) directly from the domestic/foreign interest
     * rates, for callers who have rate data rather than an observed forward quote.
     *
     * @param domesticRate rd, the domestic (compounding-period) interest rate.
     * @param foreignRate  rf, the foreign (compounding-period) interest rate.
     */
    public static Result evaluateFromRates(double spotRate, double domesticRate, double foreignRate) {
        if (spotRate <= 0 || foreignRate <= -1) {
            return null;
        }
        double impliedForward = spotRate * (1 + domesticRate) / (1 + foreignRate);
        return evaluate(spotRate, impliedForward);
    }
}
