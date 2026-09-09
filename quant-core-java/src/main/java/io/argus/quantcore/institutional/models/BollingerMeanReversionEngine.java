package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.Bollinger;

/**
 * Classical Bollinger Band mean reversion (John Bollinger's own public-domain interpretation of
 * his bands: a close at/beyond the lower band is a BUY-candidate oversold extreme, a close
 * at/beyond the upper band is a SELL-candidate overbought extreme). Built on the existing
 * Bollinger indicator (already ported byte-for-byte from
 * src/server/services/technicalSignal.ts's calcBollingerBands) rather than a new band
 * implementation - single authoritative path per the Java Quant Core Authority policy. Distinct
 * from MeanReversionZScoreEngine.java, which fades a raw price Z-score against a configurable
 * threshold rather than the specific 2-standard-deviation band convention Bollinger himself
 * defined. EXPERIMENTAL/RESEARCH status: real formula, zero live consumer, no claim of validated
 * edge.
 */
public final class BollingerMeanReversionEngine {

    private BollingerMeanReversionEngine() {
    }

    public record Result(
        double close,
        double upperBand,
        double lowerBand,
        boolean atOrBeyondUpperBand,
        boolean atOrBeyondLowerBand,
        String fadeSignal // BUY (fade the lower band), SELL (fade the upper band), NEUTRAL
    ) {
    }

    /**
     * @param closes chronological close prices.
     * @param period Bollinger lookback, e.g. 20.
     * @return null if there isn't enough history for the bands to be computable.
     */
    public static Result evaluate(double[] closes, int period) {
        if (period < 1 || closes.length < period) {
            return null;
        }
        Bollinger.Bands bands = Bollinger.calculate(closes, period);
        double close = closes[closes.length - 1];
        boolean atUpper = close >= bands.upper();
        boolean atLower = close <= bands.lower();
        String signal = atLower ? "BUY" : atUpper ? "SELL" : "NEUTRAL";
        return new Result(close, bands.upper(), bands.lower(), atUpper, atLower, signal);
    }

    /** Bollinger's own conventional 20-period default. */
    public static Result evaluate(double[] closes) {
        return evaluate(closes, 20);
    }
}
