package io.argus.quantcore.institutional.features;

import io.argus.quantcore.institutional.data.MarketDataQualityEngine.QualityReport;

/**
 * Standardized bundle of cheap, already-computed indicator features for one symbol at one point
 * in time - so models don't each independently recompute RSI/MACD/Bollinger/ATR from raw bars
 * (the exact duplication FactorAlphaEngine/GarchEngine/HmmRegimeEngine currently do implicitly by
 * each taking raw Bar[] directly). qualityReport is always attached and must be checked by the
 * caller - a snapshot built from RED-quality data still reports the real (degraded) numbers
 * rather than refusing to construct one, but FeaturePipeline.build() itself declines to build a
 * snapshot at all when quality is RED (see its own doc comment).
 */
public record FeatureSnapshot(
    String symbol,
    long asOfMs,
    double close,
    double rsi,
    double macd,
    double macdSignal,
    double bbUpper,
    double bbLower,
    double atr,
    double realizedVolatility,
    int barsUsed,
    QualityReport qualityReport
) {
}
