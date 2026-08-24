package io.argus.quantcore.institutional.features;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.indicators.Bollinger;
import io.argus.quantcore.indicators.MACD;
import io.argus.quantcore.indicators.RSI;
import io.argus.quantcore.indicators.Volatility;
import io.argus.quantcore.institutional.data.MarketDataQualityEngine;
import io.argus.quantcore.institutional.data.MarketDataQualityEngine.QualityReport;
import io.argus.quantcore.institutional.data.MarketDataQualityEngine.QualityStatus;

/**
 * The one place bars get turned into indicator features for the institutional layer - models
 * should consume a FeatureSnapshot from here rather than each independently parsing Bar[] (see
 * FeatureSnapshot's own header). Runs MarketDataQualityEngine first and refuses to build a
 * snapshot at all on RED quality (insufficient history, stale, or a structural gap/duplicate) -
 * a degraded-but-real snapshot is still returned on YELLOW (an anomaly was flagged, but the
 * indicator math itself is still real, not fabricated).
 */
public final class FeaturePipeline {

    private static final int MIN_BARS_REQUIRED = 30;
    private static final long DEFAULT_STALE_THRESHOLD_MS = 5L * 24 * 60 * 60 * 1000; // 5 real calendar days - generous for daily bars, tightened by callers using intraday data
    private static final double DEFAULT_ANOMALY_STD_DEV_THRESHOLD = 8.0;

    private FeaturePipeline() {
    }

    /** @return null when quality is RED - never a fabricated snapshot over unusable data. */
    public static FeatureSnapshot build(String symbol, Bar[] bars, long asOfMs) {
        return build(symbol, bars, asOfMs, MIN_BARS_REQUIRED, DEFAULT_STALE_THRESHOLD_MS, DEFAULT_ANOMALY_STD_DEV_THRESHOLD);
    }

    public static FeatureSnapshot build(String symbol, Bar[] bars, long asOfMs, int minBarsRequired, long staleThresholdMs, double anomalyStdDevThreshold) {
        QualityReport quality = MarketDataQualityEngine.assess(bars, asOfMs, minBarsRequired, staleThresholdMs, anomalyStdDevThreshold);
        if (quality.status() == QualityStatus.RED) {
            return null;
        }

        double[] closes = new double[bars.length];
        double[] highs = new double[bars.length];
        double[] lows = new double[bars.length];
        for (int i = 0; i < bars.length; i++) {
            closes[i] = bars[i].close();
            highs[i] = bars[i].high();
            lows[i] = bars[i].low();
        }

        RSI rsi = new RSI(14);
        MACD macd = new MACD(12, 26, 9);
        MACD.Result macdResult = macd.calculate(closes);
        Bollinger.Bands bb = Bollinger.calculate(closes, 20);
        double atr = Volatility.atr(highs, lows, closes);
        double realizedVol = realizedVolatility(closes);

        return new FeatureSnapshot(
            symbol,
            asOfMs,
            closes[closes.length - 1],
            rsi.calculate(closes),
            macdResult.macd(),
            macdResult.signal(),
            bb.upper(),
            bb.lower(),
            atr,
            realizedVol,
            bars.length,
            quality
        );
    }

    /** Simple close-to-close realized volatility (stdev of returns) - same convention FactorAlphaEngine's own volatility factor uses. */
    private static double realizedVolatility(double[] closes) {
        if (closes.length < 2) return 0;
        double[] returns = new double[closes.length - 1];
        for (int i = 1; i < closes.length; i++) {
            returns[i - 1] = closes[i - 1] == 0 ? 0 : (closes[i] - closes[i - 1]) / closes[i - 1];
        }
        double mean = 0;
        for (double r : returns) mean += r;
        mean /= returns.length;
        double variance = 0;
        for (double r : returns) variance += (r - mean) * (r - mean);
        variance /= returns.length;
        return Math.sqrt(variance);
    }
}
