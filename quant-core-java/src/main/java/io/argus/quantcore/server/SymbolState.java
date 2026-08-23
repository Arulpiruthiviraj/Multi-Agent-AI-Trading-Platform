package io.argus.quantcore.server;

import io.argus.quantcore.buffers.CircularDoubleArray;
import io.argus.quantcore.indicators.*;

/**
 * Per-symbol rolling tick history the bridge maintains for the {@code /api/v1/indicators}
 * endpoint. Ticks carry only a last-trade price (no real OHLC bar), so two indicators are
 * documented, honest approximations rather than a silent stand-in for their bar-based
 * TypeScript equivalents:
 *   - ATR here is a "tick-range" variant: each tick is treated as a degenerate bar with
 *     high == low == price, so true range collapses to |price_i - price_(i-1)|. This is NOT
 *     the same number src/server/engines/TechnicalIndicators.ts's calculateATR produces from
 *     real OHLC bars, and must never be presented as such in the shadow-parity comparator.
 *   - VWAP here is a windowed volume-weighted average over the maintained ring buffer, NOT a
 *     session-since-open VWAP (src/server/quant/indicators/volume.ts's VWAPContext resets at
 *     the real session open). Null when no tick in the window carried a volume figure.
 *
 * RSI/MACD/Bollinger ARE the same real computations as their Phase 0 parity-tested Java ports,
 * over the same price series a real close-price history would produce.
 */
final class SymbolState {
    private static final int CAPACITY = 200;
    private static final int MIN_HISTORY_FOR_INDICATORS = 26; // MACD's long period - the strictest requirement

    private final CircularDoubleArray prices = new CircularDoubleArray(CAPACITY);
    private final CircularDoubleArray volumes = new CircularDoubleArray(CAPACITY);
    private final RSI rsi = new RSI(14);
    private final MACD macd = new MACD(12, 26, 9);

    private long lastTimestampMs;

    synchronized void onTick(double price, Double volume, long timestampMs) {
        prices.push(price);
        volumes.push(volume != null ? volume : 0.0);
        lastTimestampMs = timestampMs;
    }

    synchronized IndicatorSnapshot snapshot(String symbol) {
        if (prices.size() < MIN_HISTORY_FOR_INDICATORS) {
            return new IndicatorSnapshot(1, symbol, lastTimestampMs, null, null, null, null, null, null, null, null, true);
        }
        double[] priceArr = prices.toArray();
        double[] volumeArr = volumes.toArray();

        double r = rsi.calculate(priceArr);
        MACD.Result m = macd.calculate(priceArr);
        Bollinger.Bands bb = Bollinger.calculate(priceArr, 20);
        double atr = tickRangeAtr(priceArr);
        Double vwap = windowedVwap(priceArr, volumeArr);

        return new IndicatorSnapshot(1, symbol, lastTimestampMs, r, m.macd(), m.signal(), bb.upper(), bb.lower(), atr, vwap, null, false);
    }

    private static double tickRangeAtr(double[] prices) {
        if (prices.length < 2) {
            return 0;
        }
        double sum = 0;
        int n = Math.min(14, prices.length - 1);
        for (int i = prices.length - n; i < prices.length; i++) {
            sum += Math.abs(prices[i] - prices[i - 1]);
        }
        return sum / n;
    }

    private static Double windowedVwap(double[] prices, double[] volumes) {
        double sumPv = 0, sumV = 0;
        for (int i = 0; i < prices.length; i++) {
            if (volumes[i] > 0) {
                sumPv += prices[i] * volumes[i];
                sumV += volumes[i];
            }
        }
        return sumV > 0 ? sumPv / sumV : null;
    }
}
