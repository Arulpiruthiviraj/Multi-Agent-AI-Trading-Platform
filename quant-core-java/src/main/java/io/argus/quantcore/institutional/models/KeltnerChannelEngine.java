package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.MovingAverages;
import io.argus.quantcore.indicators.Volatility;

/**
 * Keltner Channel breakout strategy. Chester Keltner's original 1960s channel concept, using the
 * modern (1980s-onward) ATR-based formulation - see Jun Lu, "Exploring Classic Quantitative
 * Strategies" (arXiv:2202.11309, 2022), Section 3.1, Eq. (3.1)-(3.2):
 *   middle = MA(typicalPrice), typicalPrice = (high+low+close)/3
 *   upper  = middle + 2*ATR
 *   lower  = middle - 2*ATR
 * ATR reused from Volatility.atr() (Wilder's-smoothed, already ported byte-for-byte from the live
 * TS engine) rather than a second ATR implementation - single authoritative path per the Java
 * Quant Core Authority policy. Middle line uses SMA (the paper explicitly allows "SMA, EMA, or
 * AMA" - SMA is the simplest, most conventional choice, not arbitrarily picked).
 *
 * Strategy (paper's own words): "if the price action breaks above the upper band, the trader
 * should consider initiating long/buy positions... If the price action breaks below the band, the
 * trader should consider initiating short/sell positions." A breakout, not a mean-reversion,
 * interpretation - deliberately distinct in direction from BollingerMeanReversionEngine.java,
 * which fades band touches rather than following them; both are real, differently-sourced
 * strategies, not a duplicate.
 */
public final class KeltnerChannelEngine {

    private KeltnerChannelEngine() {
    }

    public record Result(
        double close,
        double middle,
        double upperBand,
        double lowerBand,
        boolean brokeAboveUpper,
        boolean brokeBelowLower,
        String breakoutSignal // BUY (broke above upper), SELL (broke below lower), NEUTRAL
    ) {
    }

    /**
     * @param highs, lows, closes chronological OHLC arrays (same length).
     * @param maPeriod  middle-line SMA period.
     * @param atrPeriod ATR period (Wilder's original default: 14; paper's own tests used shorter periods).
     */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, int maPeriod, int atrPeriod) {
        if (closes == null || closes.length < Math.max(maPeriod, atrPeriod + 1)) {
            return null;
        }
        int n = closes.length;
        double[] typicalPrices = new double[n];
        for (int i = 0; i < n; i++) {
            typicalPrices[i] = (highs[i] + lows[i] + closes[i]) / 3.0;
        }
        double middle = MovingAverages.sma(typicalPrices, maPeriod);
        double atr = Volatility.atr(highs, lows, closes, atrPeriod);
        double upper = middle + 2 * atr;
        double lower = middle - 2 * atr;
        double close = closes[n - 1];

        boolean above = close > upper;
        boolean below = close < lower;
        String signal = above ? "BUY" : below ? "SELL" : "NEUTRAL";
        return new Result(close, middle, upper, lower, above, below, signal);
    }

    /** Wilder's original ATR default (14) and a matching 20-period middle line. */
    public static Result evaluate(double[] highs, double[] lows, double[] closes) {
        return evaluate(highs, lows, closes, 20, 14);
    }
}
