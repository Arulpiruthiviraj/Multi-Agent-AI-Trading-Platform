package io.argus.quantcore.features;

/**
 * Snapshot mirror of the values RegimeEngine.ts / indicators/trend.ts / indicators/volatility.ts /
 * indicators/priceAction.ts / indicators/volume.ts / indicators/supportResistance.ts read from
 * config/tradingSafety.json, config/quantThresholds.json, and config/quantExperimentalStrategies.json
 * (captured 2026-09-04, JMIG-001). Same documented gap as
 * io.argus.quantcore.strategy.types.QuantThresholds: this class exists only because there is no
 * live config-sync mechanism between the TS control plane and this standalone Java module yet - a
 * real bridge should push these values (or read the same JSON directly) rather than trust this
 * hardcoded snapshot indefinitely. Per CLAUDE.md, thresholds must not be hardcoded as TypeScript
 * literals; the Java-side equivalent of that rule is: never let this snapshot silently diverge
 * from the JSON it mirrors without updating both together.
 */
public final class FeatureThresholds {
    private FeatureThresholds() {
    }

    // config/tradingSafety.json
    public static final int REGIME_MIN_BARS = 60;
    public static final int US_EQUITY_RTH_OPEN_MINUTE = 570;
    public static final int US_EQUITY_RTH_CLOSE_MINUTE = 960;

    // config/quantThresholds.json
    public static final double MIN_ADX_TRENDING = 25;
    public static final double MIN_ADX_RANGING = 20;
    public static final double MIN_MEANINGFUL_ADX = 15;
    public static final double MIN_MEANINGFUL_PRICE_VS_MA_PCT = 0.1;
    public static final double MIN_MEANINGFUL_SLOPE_PCT = 0.05;
    public static final double VOLATILITY_PERCENTILE_HIGH = 70;
    public static final double VOLATILITY_PERCENTILE_LOW = 30;

    // config/quantExperimentalStrategies.json's `thresholds` block
    public static final int OPENING_RANGE_WINDOW_MINUTES = 30;
    public static final int DONCHIAN_PRIOR_LOOKBACK = 20;
    public static final int CLOSE_PRICE_ZSCORE_LOOKBACK = 20;
}
