package io.argus.quantcore.institutional.models;

import io.argus.quantcore.indicators.Bollinger;
import io.argus.quantcore.indicators.MovingAverages;
import io.argus.quantcore.indicators.RSI;
import io.argus.quantcore.indicators.Volatility;

/**
 * ARGUS Crypto V2 (2026-09-21) - BTC/ETH feature computation. RESEARCH status: real, tested,
 * zero HTTP endpoint, zero live consumer (see config/engineOwnership.json's "crypto_feature"
 * entry) - the same "built but not yet activated" pattern every other RESEARCH engine in this
 * package already uses (CLAUDE.md's own documented convention). Never called from the live
 * trading path; a caller must explicitly wire this in before it can influence any decision.
 *
 * Per CLAUDE.md's Java 26 Engine Authority (rule 0/1/12): new indicator/feature calculation work
 * goes to Java, not TypeScript - this class is that home for crypto. It deliberately reuses the
 * SAME indicator primitives (RSI, MovingAverages, Bollinger, Volatility) the equity engines
 * already use, rather than a second parallel implementation, per rule 2 ("TypeScript/Java must
 * not receive new duplicate implementations of a calculation that already exists authoritatively
 * elsewhere") applied symmetrically within Java itself.
 *
 * Input is a plain OHLCV bar array - this class has no notion of which exchange/venue the bars
 * came from and computes nothing about entitlement, execution, or order routing. It is pure,
 * deterministic feature computation: same bars in, same features out, always.
 */
public final class CryptoFeatureEngine {

    private CryptoFeatureEngine() {
    }

    /**
     * One symbol's own feature snapshot. `sufficientData` is false (and every derived field is a
     * safe indicator default, e.g. RSI's neutral 50) when the bar history is too short for a
     * reliable read - callers must check this before trusting the snapshot, matching this
     * codebase's own "UNKNOWN is preferred over guessing" standard (AssetClassifier.ts) applied to
     * crypto features.
     */
    public record Snapshot(
        boolean sufficientData,
        int barCount,
        double lastClose,
        // Returns over the last N bars, expressed as simple (not log) returns - null-safe callers
        // should treat NaN as "insufficient bars for this specific horizon", not zero.
        double return1Bar,
        double return5Bar,
        double return20Bar,
        // Momentum / trend
        double rateOfChange20,
        double ema9,
        double ema20,
        double ema20SlopePct,   // (ema20[last] - ema20[prior]) / ema20[prior] - trend direction/strength proxy
        // Volatility
        double atr14,
        double atrPercent,       // atr14 / lastClose - comparable across symbols with very different price levels
        double realizedVolatility, // stdev of simple returns over the same window as bollingerPeriod, annualization left to the caller (horizon-dependent for a 24/7 asset)
        // Mean reversion
        double rsi14,
        double bollingerUpper,
        double bollingerLower,
        double bollingerZScore   // (lastClose - midline) / half-band-width; 0 = at the moving average, +/-1 = at a band
    ) {
    }

    private static final int MIN_BARS = 21; // one more than the longest lookback (Bollinger/EMA20) this snapshot uses

    public static Snapshot compute(double[] closes, double[] highs, double[] lows) {
        int n = closes.length;
        if (n < MIN_BARS || highs.length != n || lows.length != n) {
            return new Snapshot(false, n, n > 0 ? closes[n - 1] : Double.NaN,
                Double.NaN, Double.NaN, Double.NaN, Double.NaN, Double.NaN, Double.NaN, Double.NaN,
                0, 0, Double.NaN, 50, Double.NaN, Double.NaN, Double.NaN);
        }

        double lastClose = closes[n - 1];
        double return1 = simpleReturn(closes, 1);
        double return5 = simpleReturn(closes, 5);
        double return20 = simpleReturn(closes, 20);
        double roc20 = return20 * 100.0;

        double[] ema9Series = MovingAverages.ema(closes, 9);
        double[] ema20Series = MovingAverages.ema(closes, 20);
        double ema9 = ema9Series[ema9Series.length - 1];
        double ema20 = ema20Series[ema20Series.length - 1];
        double ema20Prior = ema20Series[ema20Series.length - 2];
        double ema20SlopePct = ema20Prior != 0 ? (ema20 - ema20Prior) / ema20Prior * 100.0 : 0;

        double atr14 = Volatility.atr(highs, lows, closes, 14);
        double atrPercent = lastClose != 0 ? atr14 / lastClose * 100.0 : 0;
        double realizedVol = realizedVolatility(closes, 20);

        double rsi14 = new RSI(14).calculate(closes);
        Bollinger.Bands bands = Bollinger.calculate(closes, 20);
        double midline = MovingAverages.sma(closes, 20);
        double halfWidth = (bands.upper() - bands.lower()) / 2.0;
        double zScore = halfWidth != 0 ? (lastClose - midline) / halfWidth : 0;

        return new Snapshot(true, n, lastClose, return1, return5, return20, roc20,
            ema9, ema20, ema20SlopePct, atr14, atrPercent, realizedVol,
            rsi14, bands.upper(), bands.lower(), zScore);
    }

    private static double simpleReturn(double[] closes, int lookback) {
        int n = closes.length;
        if (n <= lookback || closes[n - 1 - lookback] == 0) return Double.NaN;
        return (closes[n - 1] - closes[n - 1 - lookback]) / closes[n - 1 - lookback];
    }

    /** Population-stdev of simple period-over-period returns over the trailing `period` bars. */
    private static double realizedVolatility(double[] closes, int period) {
        int n = closes.length;
        if (n < period + 1) return Double.NaN;
        double[] rets = new double[period];
        for (int i = 0; i < period; i++) {
            int idx = n - period + i;
            double prev = closes[idx - 1];
            rets[i] = prev != 0 ? (closes[idx] - prev) / prev : 0;
        }
        double mean = 0;
        for (double r : rets) mean += r;
        mean /= period;
        double sumSq = 0;
        for (double r : rets) sumSq += (r - mean) * (r - mean);
        return Math.sqrt(sumSq / period);
    }

    /**
     * Cross-asset BTC/ETH relationship features. Deliberately a SEPARATE method (not folded into
     * Snapshot) - a relationship feature requires two synchronized bar series and has no meaning
     * for a single symbol alone. Never assumes a lead/lag direction; correlation/beta are measured
     * from the supplied series, not asserted.
     */
    public record RelativeSnapshot(
        boolean sufficientData,
        int barCount,
        double ratioLast,        // primary/secondary last-close ratio (e.g. ETH/BTC)
        double ratioReturn20,    // 20-bar return of that ratio - "is the ratio widening or narrowing"
        double correlation20,    // Pearson correlation of the two symbols' simple returns, trailing 20 bars
        double relativeBeta20    // cov(secondaryReturns, primaryReturns) / var(primaryReturns) - "how much does secondary move per unit of primary" over the same window; NaN when primary variance is 0
    ) {
    }

    public static RelativeSnapshot computeRelative(double[] primaryCloses, double[] secondaryCloses) {
        int n = Math.min(primaryCloses.length, secondaryCloses.length);
        if (n < 21) {
            return new RelativeSnapshot(false, n, Double.NaN, Double.NaN, Double.NaN, Double.NaN);
        }
        double ratioLast = secondaryCloses[n - 1] != 0 ? primaryCloses[n - 1] / secondaryCloses[n - 1] : Double.NaN;
        double ratioPrior20 = secondaryCloses[n - 21] != 0 ? primaryCloses[n - 21] / secondaryCloses[n - 21] : Double.NaN;
        double ratioReturn20 = (!Double.isNaN(ratioLast) && !Double.isNaN(ratioPrior20) && ratioPrior20 != 0)
            ? (ratioLast - ratioPrior20) / ratioPrior20 : Double.NaN;

        double[] primaryRets = new double[20];
        double[] secondaryRets = new double[20];
        for (int i = 0; i < 20; i++) {
            int idx = n - 20 + i;
            double pPrev = primaryCloses[idx - 1];
            double sPrev = secondaryCloses[idx - 1];
            primaryRets[i] = pPrev != 0 ? (primaryCloses[idx] - pPrev) / pPrev : 0;
            secondaryRets[i] = sPrev != 0 ? (secondaryCloses[idx] - sPrev) / sPrev : 0;
        }
        double correlation = pearsonCorrelation(primaryRets, secondaryRets);
        double beta = beta(secondaryRets, primaryRets);

        return new RelativeSnapshot(true, n, ratioLast, ratioReturn20, correlation, beta);
    }

    private static double pearsonCorrelation(double[] a, double[] b) {
        int n = a.length;
        double meanA = mean(a);
        double meanB = mean(b);
        double cov = 0, varA = 0, varB = 0;
        for (int i = 0; i < n; i++) {
            double da = a[i] - meanA;
            double db = b[i] - meanB;
            cov += da * db;
            varA += da * da;
            varB += db * db;
        }
        double denom = Math.sqrt(varA * varB);
        return denom != 0 ? cov / denom : Double.NaN;
    }

    private static double beta(double[] dependent, double[] independent) {
        int n = independent.length;
        double meanDep = mean(dependent);
        double meanInd = mean(independent);
        double cov = 0, varInd = 0;
        for (int i = 0; i < n; i++) {
            double di = independent[i] - meanInd;
            cov += di * (dependent[i] - meanDep);
            varInd += di * di;
        }
        return varInd != 0 ? cov / varInd : Double.NaN;
    }

    private static double mean(double[] values) {
        double s = 0;
        for (double v : values) s += v;
        return s / values.length;
    }
}
