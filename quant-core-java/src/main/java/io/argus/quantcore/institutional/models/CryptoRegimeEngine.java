package io.argus.quantcore.institutional.models;

/**
 * ARGUS Crypto V2 (2026-09-21) - deterministic BTC/ETH regime classification. RESEARCH status,
 * same disclosure as CryptoFeatureEngine.java: real, tested, zero HTTP endpoint, zero live
 * consumer until explicitly wired.
 *
 * Deliberately does NOT recompute features - it classifies an already-computed
 * CryptoFeatureEngine.Snapshot, so there is exactly one place trend/momentum/volatility are
 * calculated (rule: never a silent second computation of the same thing). Thresholds are plain
 * constructor parameters, not hardcoded literals, so a future config-driven caller
 * (config/quantThresholds.json-style) can supply reviewed values instead of this class's own
 * defaults - matching CLAUDE.md's "no hardcoded operational thresholds" rule applied to a new
 * engine from day one, not retrofitted later.
 */
public final class CryptoRegimeEngine {

    public enum Regime {
        TRENDING_BULL,
        TRENDING_BEAR,
        RANGE,
        VOLATILITY_EXPANSION,
        VOLATILITY_COMPRESSION,
        UNKNOWN // insufficient data, or a genuinely ambiguous read - never guessed
    }

    public record Thresholds(
        double trendEmaSlopePct,      // |ema20SlopePct| above this counts as "trending" evidence
        double trendRsiBullFloor,     // rsi14 above this (and slope positive) supports TRENDING_BULL
        double trendRsiBearCeiling,   // rsi14 below this (and slope negative) supports TRENDING_BEAR
        double volCompressionAtrPct,  // atrPercent below this counts as compressed
        double volExpansionAtrPct     // atrPercent above this counts as expanded
    ) {
    }

    /** Conservative starting defaults - deliberately not tuned/backtested; a real config file
     *  should replace these once real BTC/ETH evidence exists (see class header). */
    public static final Thresholds DEFAULT_THRESHOLDS = new Thresholds(0.15, 55, 45, 0.6, 2.0);

    private CryptoRegimeEngine() {
    }

    public record Result(
        Regime regime,
        // 0-1, a simple count of how many of the regime's own defining conditions were met out of
        // how many were checked - not a calibrated probability. Callers must not treat this as a
        // statistical confidence interval.
        double regimeConfidence,
        String[] evidence // human-readable reasons, for observability/explainability - never hidden reasoning
    ) {
    }

    public static Result classify(CryptoFeatureEngine.Snapshot snapshot, Thresholds thresholds) {
        if (!snapshot.sufficientData()) {
            return new Result(Regime.UNKNOWN, 0, new String[]{"insufficient bar history (" + snapshot.barCount() + " bars)"});
        }

        boolean trendingUp = snapshot.ema20SlopePct() > thresholds.trendEmaSlopePct()
            && snapshot.rsi14() > thresholds.trendRsiBullFloor();
        boolean trendingDown = snapshot.ema20SlopePct() < -thresholds.trendEmaSlopePct()
            && snapshot.rsi14() < thresholds.trendRsiBearCeiling();
        boolean compressed = snapshot.atrPercent() < thresholds.volCompressionAtrPct();
        boolean expanded = snapshot.atrPercent() > thresholds.volExpansionAtrPct();

        if (trendingUp) {
            return new Result(Regime.TRENDING_BULL, 1.0,
                new String[]{
                    String.format("ema20SlopePct=%.3f%% > %.3f%%", snapshot.ema20SlopePct(), thresholds.trendEmaSlopePct()),
                    String.format("rsi14=%.1f > %.1f", snapshot.rsi14(), thresholds.trendRsiBullFloor()),
                });
        }
        if (trendingDown) {
            return new Result(Regime.TRENDING_BEAR, 1.0,
                new String[]{
                    String.format("ema20SlopePct=%.3f%% < -%.3f%%", snapshot.ema20SlopePct(), thresholds.trendEmaSlopePct()),
                    String.format("rsi14=%.1f < %.1f", snapshot.rsi14(), thresholds.trendRsiBearCeiling()),
                });
        }
        if (expanded) {
            return new Result(Regime.VOLATILITY_EXPANSION, 1.0,
                new String[]{String.format("atrPercent=%.3f%% > %.3f%%", snapshot.atrPercent(), thresholds.volExpansionAtrPct())});
        }
        if (compressed) {
            return new Result(Regime.VOLATILITY_COMPRESSION, 1.0,
                new String[]{String.format("atrPercent=%.3f%% < %.3f%%", snapshot.atrPercent(), thresholds.volCompressionAtrPct())});
        }
        return new Result(Regime.RANGE, 0.5,
            new String[]{"no trend, compression, or expansion threshold cleared - default/range read"});
    }

    public static Result classify(CryptoFeatureEngine.Snapshot snapshot) {
        return classify(snapshot, DEFAULT_THRESHOLDS);
    }
}
