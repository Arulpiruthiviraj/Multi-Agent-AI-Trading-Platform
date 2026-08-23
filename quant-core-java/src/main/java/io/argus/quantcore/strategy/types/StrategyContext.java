package io.argus.quantcore.strategy.types;

/**
 * Mirrors src/server/quant/strategies/types.ts's {@code StrategyContext} — but deliberately
 * scoped to only the fields the 5 CORE strategies (momentumBreakout, pullbackContinuation,
 * meanReversion, trendFollowing, rangeReversion) actually read, not every field on the live
 * TS interface. The live TS context is assembled by RegimeEngine.ts / trend.ts / volume.ts /
 * priceAction.ts / supportResistance.ts / MarketContext.ts — that upstream feature-computation
 * pipeline is NOT ported here; this Phase 1 pass ports the strategies' own decision logic
 * (a pure function of already-computed features per each TS file's own header comment: "never
 * re-derives indicator math, never touches raw bars"), not the feature computation itself.
 * A real Phase 1.5 would need to port RegimeEngine/trend/volume/priceAction/supportResistance/
 * MarketContext before this context could be populated from live bars in Java — tracked
 * honestly as a gap in docs/audits/JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md, not silently
 * assumed complete.
 */
public record StrategyContext(
    String symbol,
    double currentPrice,
    TrendFeatures trend,
    MomentumFeatures momentum,
    VolatilityFeatures volatility,
    VolumeFeatures volume,
    PriceActionFeatures priceAction,
    SupportResistanceFeatures supportResistance,
    RegimeResult regime,
    MarketContextResult marketContext
) {

    public record Structure(
        String event,        // "BOS_BULLISH" | "BOS_BEARISH" | "CHOCH_BULLISH" | "CHOCH_BEARISH" | null
        String trend,         // "UPTREND" | "DOWNTREND" | null
        Double lastSwingHigh,
        Double lastSwingLow
    ) {
    }

    public record PriceVsMa(double diffPct, boolean above) {
    }

    public record MovingAverages(Double sma20, Double sma50, Double sma200) {
    }

    public record Dmi(double plusDI, double minusDI, double adx) {
    }

    public record TrendFeatures(
        Structure structure,
        PriceVsMa priceVsSMA20,
        PriceVsMa priceVsSMA200,
        MovingAverages movingAverages,
        Dmi dmi // null when not enough history, matches TS's `trend.dmi | null`
    ) {
    }

    public record Macd(double macd, double signal) {
    }

    public record MomentumFeatures(
        double rsi,
        Double roc,
        Double stochasticRSI,
        Macd macd
    ) {
    }

    public record Keltner(double upper, double lower, double middle) {
    }

    public record VolatilityFeatures(
        String regime, // e.g. "EXPANDING"
        double atr,
        Keltner keltner // nullable
    ) {
    }

    public record Vwap(Double distancePct) {
    }

    public record VolumeFeatures(
        Double relativeVolume,
        Vwap vwap,
        Double cmf,
        Boolean isSpike
    ) {
    }

    public record PriceActionFeatures(String candlestick, boolean consolidating) {
    }

    public record Level(double level, double pct) {
    }

    public record Nearest(Level nearestSupport, Level nearestResistance) {
    }

    public record SupportResistanceFeatures(Nearest nearest) {
    }

    public record RegimeResult(String regime, String marketStructure, double trendStrength) {
    }

    public record SectorTrend(RegimeResult regime) {
    }

    public record Sector(SectorTrend trend) {
    }

    public record RelativeStrength(Double relativeStrengthPct) {
    }

    public record MarketContextResult(Sector sector, RelativeStrength relativeStrengthVsSPY) {
    }
}
