package io.argus.quantcore.institutional.models;

/**
 * Seagull spreads - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Sections 2.54-2.57,
 * Eq. 238-265. Three-leg combinations designed to be established near zero cost, each a variant
 * of a vertical spread or combo (risk reversal) financed/hedged by a third OTM leg. All four have
 * a genuinely piecewise breakeven that depends on the SIGN of the net premium H (positive = net
 * credit, negative = net debit) - transcribed exactly from the paper's own case-by-case formulas
 * rather than collapsed into a single expression.
 */
public final class OptionSeagullSpreadEngine {

    private OptionSeagullSpreadEngine() {
    }

    public enum SeagullType { BULLISH_SHORT_SEAGULL, BEARISH_LONG_SEAGULL, BEARISH_SHORT_SEAGULL, BULLISH_LONG_SEAGULL }

    public record Result(
        double breakeven, // single point when H != 0; the paper's own H=0 case is a range [lower,upper] - see breakevenRangeLower/Upper
        Double breakevenRangeLower, // non-null only when netPremium == 0
        Double breakevenRangeUpper, // non-null only when netPremium == 0
        double maxProfit,
        double maxLoss
    ) {
    }

    /**
     * @param strike1, strike2, strike3 K1 &lt; K2 &lt; K3, the three legs' strikes in ascending order
     *                 (the paper's own construction: K1 is always the put strike closest to the
     *                 body, K3 the far call/put wing - see each variant's own doc for exact legs).
     * @param netPremium H: signed, positive = net credit received, negative = net debit paid.
     * @return null if strikes are not strictly ascending.
     */
    public static Result evaluate(SeagullType type, double strike1, double strike2, double strike3, double netPremium) {
        if (strike1 <= 0 || strike2 <= strike1 || strike3 <= strike2) {
            return null;
        }
        double k1 = strike1, k2 = strike2, k3 = strike3, h = netPremium;

        return switch (type) {
            // Eq. 238-247: short put K1, long call K2, short call K3.
            case BULLISH_SHORT_SEAGULL -> {
                double maxProfit = k3 - k2 - h;
                double maxLoss = k1 + h;
                yield h > 0 ? new Result(k2 + h, null, null, maxProfit, maxLoss)
                    : h < 0 ? new Result(k1 + h, null, null, maxProfit, maxLoss)
                    : new Result(Double.NaN, k1, k2, maxProfit, maxLoss);
            }
            // Eq. 248-253: long put K1, short call K2, long call K3.
            case BEARISH_LONG_SEAGULL -> {
                double maxProfit = k1 - h;
                double maxLoss = k3 - k2 + h;
                yield h > 0 ? new Result(k1 - h, null, null, maxProfit, maxLoss)
                    : h < 0 ? new Result(k2 - h, null, null, maxProfit, maxLoss)
                    : new Result(Double.NaN, k1, k2, maxProfit, maxLoss);
            }
            // Eq. 254-259: short put K1, long put K2, short call K3.
            case BEARISH_SHORT_SEAGULL -> {
                double maxProfit = k2 - k1 - h;
                yield h > 0 ? new Result(k2 - h, null, null, maxProfit, Double.POSITIVE_INFINITY)
                    : h < 0 ? new Result(k3 - h, null, null, maxProfit, Double.POSITIVE_INFINITY)
                    : new Result(Double.NaN, k2, k3, maxProfit, Double.POSITIVE_INFINITY);
            }
            // Eq. 260-265: long put K1, short put K2, long call K3.
            case BULLISH_LONG_SEAGULL -> {
                double maxLoss = k2 - k1 + h;
                yield h > 0 ? new Result(k3 + h, null, null, Double.POSITIVE_INFINITY, maxLoss)
                    : h < 0 ? new Result(k2 + h, null, null, Double.POSITIVE_INFINITY, maxLoss)
                    : new Result(Double.NaN, k2, k3, Double.POSITIVE_INFINITY, maxLoss);
            }
        };
    }
}
