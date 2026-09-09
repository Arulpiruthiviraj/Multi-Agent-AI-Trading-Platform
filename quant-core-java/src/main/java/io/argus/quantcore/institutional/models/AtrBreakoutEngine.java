package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.Volatility;

/**
 * ATR breakout - Wilder's ATR (Wilder, "New Concepts in Technical Trading Systems", 1978) used as
 * a per-bar volatility-normalized breakout trigger: enter when the current close clears the prior
 * close by more than k * ATR, a standard practitioner technique (distinct from
 * KeltnerChannelEngine.java's channel-midline-based breakout - this triggers off the prior bar's
 * own close, not a moving-average envelope; both are real, differently-constructed breakout
 * definitions, not duplicates). Reuses Volatility.atr() rather than a second ATR implementation.
 */
public final class AtrBreakoutEngine {

    private AtrBreakoutEngine() {
    }

    public record Result(
        double close,
        double previousClose,
        double atr,
        double upperTrigger,
        double lowerTrigger,
        String breakoutSignal // BUY (cleared upperTrigger), SELL (cleared lowerTrigger), NEUTRAL
    ) {
    }

    /**
     * @param atrMultiple how many ATRs beyond the prior close counts as a breakout (e.g. 1.5 -
     *                    caller-supplied, not defaulted; practitioner convention varies 1-3x).
     * @param atrPeriod   Wilder's own conventional default is 14.
     * @return null if there isn't enough history for the ATR period.
     */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, double atrMultiple, int atrPeriod) {
        int n = closes.length;
        if (highs.length != n || lows.length != n || n < atrPeriod + 2) {
            return null;
        }
        double atr = Volatility.atr(highs, lows, closes, atrPeriod);
        if (atr == 0) {
            return null;
        }
        double close = closes[n - 1];
        double previousClose = closes[n - 2];
        double upperTrigger = previousClose + atrMultiple * atr;
        double lowerTrigger = previousClose - atrMultiple * atr;

        String signal = close > upperTrigger ? "BUY" : close < lowerTrigger ? "SELL" : "NEUTRAL";
        return new Result(close, previousClose, atr, upperTrigger, lowerTrigger, signal);
    }

    /** Wilder's own conventional 14-period ATR, with a 1.5x multiple (a common, not-universal, practitioner default). */
    public static Result evaluate(double[] highs, double[] lows, double[] closes) {
        return evaluate(highs, lows, closes, 1.5, 14);
    }
}
