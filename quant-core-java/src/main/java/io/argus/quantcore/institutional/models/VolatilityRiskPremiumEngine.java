package io.argus.quantcore.institutional.models;

/**
 * Volatility risk premium signal - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section
 * 7.4. Implied volatility tends to exceed realized volatility most of the time; the paper's own
 * proxy is the spread between VIX at the start of the current month and realized S&amp;P 500
 * volatility since then. Positive spread -&gt; sell volatility (e.g. short a straddle); the strategy
 * loses money on volatility spikes (typically market selloffs) and profits in sideways markets.
 */
public final class VolatilityRiskPremiumEngine {

    private VolatilityRiskPremiumEngine() {
    }

    public record Result(
        double spread,
        String signal // SELL_VOLATILITY (positive spread), NEUTRAL (non-positive)
    ) {
    }

    /**
     * @param impliedVolatilityAtMonthStart VIX (or equivalent) at the start of the current month, in %.
     * @param realizedVolatilitySinceMonthStart realized volatility of daily returns since the
     *                                           start of the month, in % (same units as VIX).
     */
    public static Result evaluate(double impliedVolatilityAtMonthStart, double realizedVolatilitySinceMonthStart) {
        double spread = impliedVolatilityAtMonthStart - realizedVolatilitySinceMonthStart;
        String signal = spread > 0 ? "SELL_VOLATILITY" : "NEUTRAL";
        return new Result(spread, signal);
    }
}
