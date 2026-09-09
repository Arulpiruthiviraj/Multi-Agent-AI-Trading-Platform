package io.argus.quantcore.institutional.models;

/**
 * VIX futures basis trading - Kakushadze &amp; Serur, "151 Trading Strategies" (2018), Section 7.2,
 * Eq. 429-431. A mean-reversion strategy: the VIX futures basis has little forecasting power for
 * subsequent VIX changes but real forecasting power for subsequent VIX FUTURES price changes -
 * futures prices tend to fall when the basis is positive (contango) and rise when negative
 * (backwardation). Implements the paper's own worked trading rule (Eq. 431) directly.
 */
public final class VixFuturesBasisEngine {

    private VixFuturesBasisEngine() {
    }

    public enum Signal { OPEN_LONG, CLOSE_LONG, OPEN_SHORT, CLOSE_SHORT, NONE }

    public record Result(
        double basis,   // Eq. 429: B_VIX = P_UX1 - P_VIX
        double dailyRoll, // Eq. 430: D = B_VIX / T
        Signal signal
    ) {
    }

    /**
     * @param frontMonthFuturesPrice P_UX1.
     * @param vixSpot                P_VIX.
     * @param businessDaysToSettlement T, must be at least 10 per the paper's own convention.
     * @param currentlyLong, currentlyShort whether a position from a prior signal is open, needed
     *                       to evaluate the close-position thresholds correctly.
     * @return null if businessDaysToSettlement is not positive.
     */
    public static Result evaluate(double frontMonthFuturesPrice, double vixSpot, double businessDaysToSettlement,
                                   boolean currentlyLong, boolean currentlyShort) {
        if (businessDaysToSettlement <= 0) {
            return null;
        }
        double basis = frontMonthFuturesPrice - vixSpot;
        double dailyRoll = basis / businessDaysToSettlement;

        Signal signal;
        if (currentlyLong && dailyRoll > -0.05) {
            signal = Signal.CLOSE_LONG;
        } else if (currentlyShort && dailyRoll < 0.05) {
            signal = Signal.CLOSE_SHORT;
        } else if (!currentlyLong && !currentlyShort && dailyRoll < -0.10) {
            signal = Signal.OPEN_LONG;
        } else if (!currentlyLong && !currentlyShort && dailyRoll > 0.10) {
            signal = Signal.OPEN_SHORT;
        } else {
            signal = Signal.NONE;
        }

        return new Result(basis, dailyRoll, signal);
    }
}
