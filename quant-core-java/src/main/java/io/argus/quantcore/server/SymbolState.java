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

    /**
     * Sequence tracking added 2026-09-10 (docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md
     * §6) — the confirmed, root-caused fix for the RSI/MACD shadow-parity divergence: the prior
     * fire-and-forget POST /api/v1/ticks had no way for this class to know a tick had been dropped,
     * so one lost HTTP call permanently diverged this buffer from TS's own price history (RSI/MACD's
     * recursive smoothing never self-corrects the way a plain SMA would). -1 means "no sequence
     * established yet" — the first tick with a sequence number initializes it rather than being
     * treated as a gap.
     */
    private long lastAppliedSequence = -1;

    /** No-sequence overload — kept for any caller (tests, etc.) that doesn't send one; never treated as a gap. */
    synchronized void onTick(double price, Double volume, long timestampMs) {
        applyTick(price, volume, timestampMs);
    }

    /**
     * Returns true if a gap was detected (the received sequence is not exactly
     * lastAppliedSequence+1) — the caller (QuantCoreServer.handleTicks) reports this back to TS so
     * the bridge can trigger a resync. The tick is still applied either way (never discarded) —
     * detecting a gap does not mean refusing data, it means flagging that a resync is now needed.
     */
    synchronized boolean onTick(double price, Double volume, long timestampMs, long sequence) {
        boolean gap = lastAppliedSequence >= 0 && sequence != lastAppliedSequence + 1;
        lastAppliedSequence = sequence;
        applyTick(price, volume, timestampMs);
        return gap;
    }

    private void applyTick(double price, Double volume, long timestampMs) {
        prices.push(price);
        volumes.push(volume != null ? volume : 0.0);
        lastTimestampMs = timestampMs;
    }

    /**
     * Wholesale state resynchronization from a canonical TS-supplied snapshot — the fix for a
     * detected gap, a Java restart (this class has no persistence; a fresh instance starts with
     * lastAppliedSequence=-1 and empty buffers until this is called), or a periodic safety-net
     * resync. Replaces prices/volumes entirely (CircularDoubleArray.reset) rather than appending,
     * so a resync is idempotent and self-healing regardless of how diverged the prior state was.
     */
    synchronized void resync(double[] priceHistory, double[] volumeHistory, long sequence, long timestampMs) {
        prices.reset(priceHistory);
        volumes.reset(volumeHistory != null ? volumeHistory : new double[0]);
        lastAppliedSequence = sequence;
        lastTimestampMs = timestampMs;
    }

    synchronized long lastAppliedSequence() {
        return lastAppliedSequence;
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
        // Defensive bound, not just prices.length: a resync() can in principle leave the two
        // CircularDoubleArrays at different counts if a caller ever supplies mismatched-length
        // price/volume histories - never index past the shorter one rather than throwing.
        int n = Math.min(prices.length, volumes.length);
        for (int i = 0; i < n; i++) {
            if (volumes[i] > 0) {
                sumPv += prices[i] * volumes[i];
                sumV += volumes[i];
            }
        }
        return sumV > 0 ? sumPv / sumV : null;
    }
}
