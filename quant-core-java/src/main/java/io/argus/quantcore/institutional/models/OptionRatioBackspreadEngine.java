package io.argus.quantcore.institutional.models;

/**
 * Call Ratio Backspread (sell 1 call A, buy 2 calls B, A&lt;B) and Put Ratio Backspread (sell 1
 * put B, buy 2 puts A, A&lt;B) - ASX "Understanding Options Trading" booklet, Strategies 6 and 12.
 * A volatility-BUYING structure (opposite of {@link OptionRatioSpreadEngine}): established for a
 * net CREDIT, with unlimited (calls) or floor-bounded-but-large (puts) profit on the side the
 * extra long leg dominates, and a bounded max loss at the short strike. All bound values
 * independently re-derived from the payoff function and cross-checked against the source's own
 * stated max-loss formula (which matches exactly for both variants).
 */
public final class OptionRatioBackspreadEngine {

    private OptionRatioBackspreadEngine() {
    }

    public enum BackspreadType { CALL_RATIO_BACKSPREAD, PUT_RATIO_BACKSPREAD }

    public record Result(
        double breakevenNearSide,
        double breakevenFarSide,
        double maxLoss,
        double floorProfit // profit on the side away from the extra long leg's exposure
    ) {
    }

    /**
     * @param strikeA, strikeB A &lt; B: for CALL_RATIO_BACKSPREAD, A is the short-call strike and
     *                 B the long-calls (x2) strike; for PUT_RATIO_BACKSPREAD, A is the long-puts
     *                 (x2) strike and B the short-put strike.
     * @param netCredit net credit received opening the position; must be nonnegative and not
     *                  exceed the strike width (a structurally impossible quote otherwise).
     * @return null if strikeB &lt;= strikeA, or netCredit is out of [0, width].
     */
    public static Result evaluate(BackspreadType type, double strikeA, double strikeB, double netCredit) {
        if (strikeA <= 0 || strikeB <= strikeA || netCredit < 0) {
            return null;
        }
        double width = strikeB - strikeA;
        if (netCredit > width) {
            return null;
        }
        double maxLoss = width - netCredit;

        if (type == BackspreadType.CALL_RATIO_BACKSPREAD) {
            double breakevenNearSide = strikeA + netCredit;
            double breakevenFarSide = 2 * strikeB - strikeA - netCredit;
            return new Result(breakevenNearSide, breakevenFarSide, maxLoss, netCredit);
        } else {
            double breakevenNearSide = strikeB - netCredit;
            double breakevenFarSide = netCredit + 2 * strikeA - strikeB;
            return new Result(breakevenNearSide, breakevenFarSide, maxLoss, netCredit);
        }
    }
}
