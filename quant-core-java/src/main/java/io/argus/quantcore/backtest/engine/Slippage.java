package io.argus.quantcore.backtest.engine;

import io.argus.quantcore.indicators.Volatility;

/** Ported byte-for-byte from src/server/engines/backtest/Slippage.ts (config/quantThresholds.json snapshot, 2026-08-21). */
public final class Slippage {

    public static final double BASE_SLIPPAGE_PCT = 0.0005;
    public static final double ATR_SLIPPAGE_MULTIPLIER = 0.05;
    public static final double SIZE_IMPACT_MULTIPLIER = 0.5;
    public static final double MAX_SLIPPAGE_PCT = 0.05;

    private Slippage() {
    }

    public static double calculateDynamicSlippagePct(double[] highs, double[] lows, double[] closes,
                                                       double currentPrice, double orderShares, double barVolume) {
        double atr = Volatility.atr(highs, lows, closes, 14);
        double atrComponent = currentPrice > 0 ? (atr / currentPrice) * ATR_SLIPPAGE_MULTIPLIER : 0;
        double sizeComponent = barVolume > 0 ? Math.min(1, orderShares / barVolume) * SIZE_IMPACT_MULTIPLIER : 0;
        return Math.min(MAX_SLIPPAGE_PCT, BASE_SLIPPAGE_PCT + atrComponent + sizeComponent);
    }
}
