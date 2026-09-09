package io.argus.quantcore.institutional.models;

/**
 * Short Iron Condor Spread (long put A + short put B + short call C + long call D, A&lt;B&lt;C&lt;D,
 * established for a net credit) - Fidelity's "A Quick Guide to Trading Options." A bull put spread
 * (B/A) combined with a bear call spread (C/D). Formula independently re-derived and confirmed
 * against Fidelity's own worked example (95/100/105/110 strikes, 2.80 net credit -> 2.20 max risk).
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
     * @param longPutStrike  A (lowest).
     * @param shortPutStrike B.
     * @param shortCallStrike C.
     * @param longCallStrike D (highest), with (B-A) == (D-C), the standard equal-width construction.
     * @param netCredit      net credit received opening the position; must be nonnegative.
     * @return null if strikes are not properly ordered/equal-winged, or netCredit exceeds the
     *         wing width (a structurally impossible quote).
     */
    public static Result evaluate(double longPutStrike, double shortPutStrike, double shortCallStrike, double longCallStrike, double netCredit) {
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
}
