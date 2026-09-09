package io.argus.quantcore.institutional.models;

/**
 * Ratio Call Spread (buy 1 call A, sell 2 calls B, A&lt;B) and Ratio Put Spread (sell 2 puts A,
 * buy 1 put B, A&lt;B) - ASX "Understanding Options Trading" booklet, Strategies 17-18. Distinct
 * from {@link OptionRatioBackspreadEngine} (which sells 1 / buys 2 at the OPPOSITE strike
 * ordering - a volatility-buying structure) - this is a volatility-SELLING structure targeting
 * max profit near the ratio strike (B for calls, A for puts). All four bound values below were
 * independently re-derived from the payoff function (verified by hand across every price region),
 * not transcribed - the Ratio Put Spread's downside bound in particular is a genuinely asymmetric
 * closed form the source only describes qualitatively ("limited on the downside").
 */
public final class OptionRatioSpreadEngine {

    private OptionRatioSpreadEngine() {
    }

    public enum SpreadType { RATIO_CALL_SPREAD, RATIO_PUT_SPREAD }

    public record Result(
        double breakevenLower,
        double breakevenUpper,
        double maxProfit,
        double maxLossUpside,
        double maxLossDownside
    ) {
    }

    /**
     * @param strikeA, strikeB A &lt; B: for RATIO_CALL_SPREAD, A is the long-call strike and B the
     *                 short-calls (x2) strike; for RATIO_PUT_SPREAD, A is the short-puts (x2)
     *                 strike and B the long-put strike.
     * @param netCost  net cost of the position (can be a net debit or, per the source's own
     *                 generic framing, a net credit expressed as a negative cost); the source
     *                 does not fix its sign, so this class accepts it as supplied.
     * @return null if strikeB &lt;= strikeA.
     */
    public static Result evaluate(SpreadType type, double strikeA, double strikeB, double netCost) {
        if (strikeA <= 0 || strikeB <= strikeA) {
            return null;
        }
        double width = strikeB - strikeA;
        double maxProfit = width - netCost;

        if (type == SpreadType.RATIO_CALL_SPREAD) {
            double breakevenLower = strikeA + netCost;
            double breakevenUpper = 2 * strikeB - strikeA - netCost;
            return new Result(breakevenLower, breakevenUpper, maxProfit, Double.POSITIVE_INFINITY, netCost);
        } else {
            double breakevenUpper = strikeB - netCost;
            double downsideBoundAtZero = netCost + 2 * strikeA - strikeB; // payoff floor at S=0
            double breakevenLower = netCost + 2 * strikeA - strikeB; // where payoff crosses zero in [0, A]
            return new Result(breakevenLower, breakevenUpper, maxProfit, netCost, downsideBoundAtZero);
        }
    }
}
