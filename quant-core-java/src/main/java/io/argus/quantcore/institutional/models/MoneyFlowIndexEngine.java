package io.argus.quantcore.institutional.models;

/**
 * Money Flow Index (MFI) - Gene Quong &amp; Avrum Soudack's public-domain, volume-weighted RSI
 * variant (1989 practitioner technique). Per bar: typicalPrice = (high+low+close)/3, rawMoneyFlow
 * = typicalPrice * volume. Over a rolling period, positiveMoneyFlow sums rawMoneyFlow on bars
 * where typical price rose versus the prior bar, negativeMoneyFlow sums it on bars where typical
 * price fell. moneyFlowRatio = positiveMoneyFlow / negativeMoneyFlow; MFI = 100 - 100/(1+ratio).
 *
 * Strategy: same overbought/oversold convention as RSI, using MFI's own standard 80/20 bands
 * (not RSI's 70/30) - a universally standard convention for this indicator, not an invented
 * threshold, same status as RSI's own 70/30 bands elsewhere in this codebase.
 */
public final class MoneyFlowIndexEngine {

    private MoneyFlowIndexEngine() {
    }

    public record Result(
        double mfi,
        boolean overbought,
        boolean oversold,
        String signal // BUY (oversold), SELL (overbought), NEUTRAL
    ) {
    }

    /**
     * @param period conventional default is 14 (matching this codebase's own RSI default).
     * @return null if there isn't enough history.
     */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, double[] volumes, int period) {
        int n = closes.length;
        if (highs.length != n || lows.length != n || volumes.length != n || period < 1 || n < period + 1) {
            return null;
        }
        double[] typicalPrices = new double[n];
        for (int i = 0; i < n; i++) {
            typicalPrices[i] = (highs[i] + lows[i] + closes[i]) / 3.0;
        }
        double positiveFlow = 0, negativeFlow = 0;
        for (int i = n - period; i < n; i++) {
            double rawMoneyFlow = typicalPrices[i] * volumes[i];
            if (typicalPrices[i] > typicalPrices[i - 1]) positiveFlow += rawMoneyFlow;
            else if (typicalPrices[i] < typicalPrices[i - 1]) negativeFlow += rawMoneyFlow;
            // unchanged typical price contributes to neither, matching the standard definition
        }
        double mfi;
        if (negativeFlow == 0) {
            mfi = 100; // no selling pressure at all in the window - the honest ratio->infinity limit, not a guess
        } else {
            double moneyFlowRatio = positiveFlow / negativeFlow;
            mfi = 100 - (100 / (1 + moneyFlowRatio));
        }
        boolean overbought = mfi >= 80;
        boolean oversold = mfi <= 20;
        String signal = oversold ? "BUY" : overbought ? "SELL" : "NEUTRAL";
        return new Result(mfi, overbought, oversold, signal);
    }

    /** Conventional 14-period default. */
    public static Result evaluate(double[] highs, double[] lows, double[] closes, double[] volumes) {
        return evaluate(highs, lows, closes, volumes, 14);
    }
}
