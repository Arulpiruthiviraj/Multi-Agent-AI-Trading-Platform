package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.RSI;

/**
 * Classical 2-period RSI mean reversion (Larry Connors, public-domain formula documented in
 * "Short Term Trading Strategies That Work" - not a proprietary or paywalled rule set): oversold
 * when RSI(2) falls below a low threshold (conventionally 10), overbought when it rises above a
 * high threshold (conventionally 70/90 depending on the variant). Built on the existing RSI
 * indicator (already ported byte-for-byte from src/server/engines/RSIEngine.ts) rather than a new
 * RSI implementation - single authoritative path per the Java Quant Core Authority policy.
 * EXPERIMENTAL/RESEARCH status: real formula, zero live consumer, no claim of validated edge.
 */
public final class RsiMeanReversionEngine {

    private RsiMeanReversionEngine() {
    }

    /** Connors' own conventional defaults. Callers may pass other thresholds for research. */
    public static final int DEFAULT_PERIOD = 2;
    public static final double DEFAULT_OVERSOLD = 10.0;
    public static final double DEFAULT_OVERBOUGHT = 70.0;

    public record Result(
        double rsi,
        boolean oversold,
        boolean overbought,
        String fadeSignal // BUY (fade oversold), SELL (fade overbought), NEUTRAL
    ) {
    }

    /**
     * @param closes           chronological close prices.
     * @param period           RSI lookback, e.g. 2.
     * @param oversoldThreshold  RSI below this is a BUY candidate, e.g. 10.
     * @param overboughtThreshold RSI above this is a SELL candidate, e.g. 70. Must be &gt; oversoldThreshold.
     * @return null if there isn't enough history for the RSI period to settle, or thresholds are invalid.
     */
    public static Result evaluate(double[] closes, int period, double oversoldThreshold, double overboughtThreshold) {
        if (period < 1 || overboughtThreshold <= oversoldThreshold || closes.length <= period) {
            return null;
        }
        double rsi = new RSI(period).calculate(closes);
        boolean oversold = rsi < oversoldThreshold;
        boolean overbought = rsi > overboughtThreshold;
        String signal = oversold ? "BUY" : overbought ? "SELL" : "NEUTRAL";
        return new Result(rsi, oversold, overbought, signal);
    }

    /** Connors' own conventional 2/10/70 defaults. */
    public static Result evaluate(double[] closes) {
        return evaluate(closes, DEFAULT_PERIOD, DEFAULT_OVERSOLD, DEFAULT_OVERBOUGHT);
    }
}
