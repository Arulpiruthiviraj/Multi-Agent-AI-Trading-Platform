package io.argus.quantcore.institutional.data;

import io.argus.quantcore.backtest.engine.Bar;

import java.util.ArrayList;
import java.util.List;

/**
 * Real, deterministic data-quality gate for any model consuming bars - staleness, sufficient
 * history, single-bar return anomalies (bad-tick proxy), and out-of-order/duplicate timestamps.
 * No model in this codebase should consume raw bars without checking this first (see
 * FeaturePipeline, which enforces it). Never fabricates a GREEN verdict - RED/YELLOW findings are
 * always real, derived from the bars actually supplied.
 */
public final class MarketDataQualityEngine {

    public enum QualityStatus { GREEN, YELLOW, RED }

    public record QualityReport(
        QualityStatus status,
        boolean stale,
        boolean sufficientHistory,
        boolean anomalyDetected,
        boolean gapDetected,
        int barsProvided,
        long lastBarAgeMs,
        String[] issues
    ) {
    }

    private MarketDataQualityEngine() {
    }

    /**
     * @param bars                    chronological, oldest first.
     * @param asOfMs                  the caller's "now" - real wall clock or replay clock, never assumed.
     * @param minBarsRequired         floor below which "sufficient history" fails.
     * @param staleThresholdMs        max age of the last bar before "stale" fails.
     * @param anomalyStdDevThreshold  single-bar return z-score magnitude above which a bar is flagged as an anomaly.
     */
    public static QualityReport assess(Bar[] bars, long asOfMs, int minBarsRequired, long staleThresholdMs, double anomalyStdDevThreshold) {
        List<String> issues = new ArrayList<>();
        if (bars == null || bars.length == 0) {
            return new QualityReport(QualityStatus.RED, true, false, false, false, 0, Long.MAX_VALUE, new String[]{"NO_BARS"});
        }

        boolean sufficientHistory = bars.length >= minBarsRequired;
        if (!sufficientHistory) issues.add("INSUFFICIENT_HISTORY");

        long lastBarAgeMs = asOfMs - bars[bars.length - 1].timestampMs();
        boolean stale = lastBarAgeMs > staleThresholdMs;
        if (stale) issues.add("STALE_DATA");

        boolean gapDetected = false;
        for (int i = 1; i < bars.length; i++) {
            if (bars[i].timestampMs() <= bars[i - 1].timestampMs()) {
                gapDetected = true;
                break;
            }
        }
        if (gapDetected) issues.add("OUT_OF_ORDER_OR_DUPLICATE_BARS");

        boolean anomalyDetected = false;
        if (bars.length >= 5) {
            double[] returns = new double[bars.length - 1];
            for (int i = 1; i < bars.length; i++) {
                double prev = bars[i - 1].close();
                returns[i - 1] = prev == 0 ? 0 : (bars[i].close() - prev) / prev;
            }
            double mean = 0;
            for (double r : returns) mean += r;
            mean /= returns.length;
            double variance = 0;
            for (double r : returns) variance += (r - mean) * (r - mean);
            variance /= returns.length;
            double std = Math.sqrt(variance);
            if (std > 1e-12) {
                for (double r : returns) {
                    if (Math.abs(r - mean) > anomalyStdDevThreshold * std) {
                        anomalyDetected = true;
                        break;
                    }
                }
            }
        }
        if (anomalyDetected) issues.add("PRICE_ANOMALY");

        QualityStatus status = (!sufficientHistory || stale || gapDetected)
            ? QualityStatus.RED
            : anomalyDetected ? QualityStatus.YELLOW : QualityStatus.GREEN;

        return new QualityReport(status, stale, sufficientHistory, anomalyDetected, gapDetected, bars.length, lastBarAgeMs, issues.toArray(new String[0]));
    }
}
