package io.argus.quantcore.institutional.models;

/**
 * Iron Condor Spread (long put A + short put B + short call C + long call D, A&lt;B&lt;C&lt;D, equal
 * wing widths) - cross-validated across Fidelity's "A Quick Guide to Trading Options" (confirmed
 * against its own worked example: 95/100/105/110 strikes, 2.80 net credit -&gt; 2.20 max risk) and
 * Kakushadze &amp; Serur, "151 Trading Strategies" (2018) Sections 2.50-2.51, Eq. 226-235.
 *
 * <p><b>Naming note:</b> the NET-CREDIT construction (long put A + short put B + short call C +
 * long call D) that Fidelity calls "Short Iron Condor" is the SAME construction Kakushadze &amp;
 * Serur call "Long Iron Condor" (Sec 2.50) - the two sources use opposite long/short labels for
 * the identical payoff. {@link #evaluateNetCredit} is that construction, kept under its original
 * method name for compatibility. {@link #evaluateNetDebit} is the true mirror position (short put
 * A + long put B + long call C + short call D, Sec 2.51's own "Short Iron Condor") - a distinct
 * payoff, not just a renamed duplicate.
 */
public final class OptionIronCondorEngine {

    private OptionIronCondorEngine() {
    }

    public record Result(
        double breakevenLower,
        double breakevenUpper,
        double maxProfit,
        double maxRisk
    ) {
    }

    /**
     * The net-credit construction: long put A + short put B + short call C + long call D.
     * Fidelity's "Short Iron Condor"; Kakushadze &amp; Serur's "Long Iron Condor" (Sec 2.50, Eq. 226-230).
     *
     * @param longPutStrike  A (lowest).
     * @param shortPutStrike B.
     * @param shortCallStrike C.
     * @param longCallStrike D (highest), with (B-A) == (D-C), the standard equal-width construction.
     * @param netCredit      net credit received opening the position; must be nonnegative.
     * @return null if strikes are not properly ordered/equal-winged, or netCredit exceeds the
     *         wing width (a structurally impossible quote).
     */
    public static Result evaluateNetCredit(double longPutStrike, double shortPutStrike, double shortCallStrike, double longCallStrike, double netCredit) {
        if (longPutStrike <= 0 || shortPutStrike <= longPutStrike || shortCallStrike <= shortPutStrike
            || longCallStrike <= shortCallStrike || netCredit < 0) {
            return null;
        }
        double putWingWidth = shortPutStrike - longPutStrike;
        double callWingWidth = longCallStrike - shortCallStrike;
        if (Math.abs(putWingWidth - callWingWidth) > 1e-9) {
            return null;
        }
        if (netCredit > putWingWidth) {
            return null;
        }

        double breakevenLower = shortPutStrike - netCredit;
        double breakevenUpper = shortCallStrike + netCredit;
        double maxRisk = putWingWidth - netCredit;

        return new Result(breakevenLower, breakevenUpper, netCredit, maxRisk);
    }

    /** @deprecated kept for compatibility with existing callers; use {@link #evaluateNetCredit} directly. */
    @Deprecated
    public static Result evaluate(double longPutStrike, double shortPutStrike, double shortCallStrike, double longCallStrike, double netCredit) {
        return evaluateNetCredit(longPutStrike, shortPutStrike, shortCallStrike, longCallStrike, netCredit);
    }

    /**
     * The net-debit mirror construction: short put A + long put B + long call C + short call D.
     * Kakushadze &amp; Serur's own "Short Iron Condor" (Sec 2.51, Eq. 231-235) - genuinely the
     * opposite position from {@link #evaluateNetCredit}, not a renamed duplicate.
     *
     * @param shortPutStrike A (lowest).
     * @param longPutStrike  B.
     * @param longCallStrike C.
     * @param shortCallStrike D (highest), with (B-A) == (D-C).
     * @param netDebit       net debit paid opening the position; must be nonnegative.
     * @return null if strikes are not properly ordered/equal-winged, or netDebit exceeds the wing width.
     */
    public static Result evaluateNetDebit(double shortPutStrike, double longPutStrike, double longCallStrike, double shortCallStrike, double netDebit) {
        if (shortPutStrike <= 0 || longPutStrike <= shortPutStrike || longCallStrike <= longPutStrike
            || shortCallStrike <= longCallStrike || netDebit < 0) {
            return null;
        }
        double putWingWidth = longPutStrike - shortPutStrike;
        double callWingWidth = shortCallStrike - longCallStrike;
        if (Math.abs(putWingWidth - callWingWidth) > 1e-9) {
            return null;
        }
        if (netDebit > putWingWidth) {
            return null;
        }

        double breakevenLower = longPutStrike - netDebit;
        double breakevenUpper = longCallStrike + netDebit;
        double maxProfit = putWingWidth - netDebit;

        return new Result(breakevenLower, breakevenUpper, maxProfit, netDebit);
    }
}
