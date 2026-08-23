package io.argus.quantcore.strategy.types;

/**
 * Snapshot mirror of the values this migration's CORE strategies read from config/quantThresholds.json
 * (captured 2026-08-21). Per CLAUDE.md, thresholds must not be hardcoded as TypeScript literals —
 * the same rule applies here: this class exists only because Phase 1 has no live config-sync
 * mechanism between the TS control plane and this standalone Java module yet. A real Phase 2+
 * bridge should push these values from the TS process's already-loaded config at startup (or
 * read the same JSON file directly) rather than trust this hardcoded snapshot indefinitely —
 * tracked as a known gap, not a design decision to duplicate config ownership.
 */
public final class QuantThresholds {
    private QuantThresholds() {
    }

    public static final double RSI_OVERBOUGHT = 70;
    public static final double RSI_OVERSOLD = 30;
    public static final double STOCH_RSI_OVERSOLD = 20;
    public static final double STOCH_RSI_OVERBOUGHT = 80;
    public static final double HEALTHY_RSI_MIN = 35;
    public static final double HEALTHY_RSI_MAX = 65;
    public static final double MIN_TREND_STRENGTH = 50;
    public static final double MIN_ADX_TRENDING = 25;
    public static final double RVOL_THRESHOLD = 1.5;
    public static final double PULLBACK_TOLERANCE_PCT = 3;
    public static final double NEAR_BOUNDARY_PCT = 1.5;
}
