package io.argus.quantcore.indicators;

/**
 * Wilder's-smoothed ATR, ported byte-for-byte from src/server/engines/TechnicalIndicators.ts's
 * {@code calculateATR}.
 */
public final class Volatility {

    private Volatility() {
    }

    /** Returns 0 when there isn't a full period+1 bars of history yet, matching the TS source. */
    public static double atr(double[] highs, double[] lows, double[] closes, int period) {
        if (closes.length < period + 1) {
            return 0;
        }
        double[] trs = new double[closes.length - 1];
        for (int i = 1; i < closes.length; i++) {
            double hl = highs[i] - lows[i];
            double hc = Math.abs(highs[i] - closes[i - 1]);
            double lc = Math.abs(lows[i] - closes[i - 1]);
            trs[i - 1] = Math.max(hl, Math.max(hc, lc));
        }
        double atr = 0;
        for (int i = 0; i < period; i++) {
            atr += trs[i];
        }
        atr /= period;
        for (int i = period; i < trs.length; i++) {
            atr = ((atr * (period - 1)) + trs[i]) / period;
        }
        return atr;
    }

    /** Default 14-period ATR. */
    public static double atr(double[] highs, double[] lows, double[] closes) {
        return atr(highs, lows, closes, 14);
    }
}
