package io.argus.quantcore.strategy.institutional;

import io.argus.quantcore.backtest.engine.Bar;

/**
 * Separate from {@link io.argus.quantcore.strategy.types.StrategyContext} deliberately: the 5
 * CORE strategies are single-symbol functions of already-computed technical features (RSI,
 * Keltner, regime, ...); the institutional strategies here are functions of raw OHLCV bar
 * history for one or two symbols (StatArb inherently needs a pair; multi-factor needs the full
 * bar series to compute its own rolling windows). Reusing StrategyContext would mean fabricating
 * feature fields these strategies don't use, so a dedicated, honestly-scoped context is used
 * instead - registered separately in StrategyRegistry, not folded into the CORE map.
 */
public record InstitutionalStrategyContext(
    String primarySymbol,
    Bar[] primaryBars,
    String pairSymbol,   // null when no pair is configured (MultiFactorMomentumStrategy ignores this)
    Bar[] pairBars       // null when no pair is configured
) {
    public static InstitutionalStrategyContext singleSymbol(String symbol, Bar[] bars) {
        return new InstitutionalStrategyContext(symbol, bars, null, null);
    }

    public static InstitutionalStrategyContext pair(String primarySymbol, Bar[] primaryBars, String pairSymbol, Bar[] pairBars) {
        return new InstitutionalStrategyContext(primarySymbol, primaryBars, pairSymbol, pairBars);
    }
}
