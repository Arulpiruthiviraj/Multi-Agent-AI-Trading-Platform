package io.argus.quantcore.strategy.core;

import io.argus.quantcore.strategy.types.StrategyContext;
import io.argus.quantcore.strategy.types.StrategyContext.*;

/**
 * Mirrors the three synthetic StrategyContext fixtures in
 * scripts/java_parity_fixtures_phase1.ts's {@code makeContext(...)} calls exactly, field for
 * field, so the same inputs are fed to both the real TypeScript strategies and these Java ports.
 */
final class StrategyFixtures {

    private StrategyFixtures() {
    }

    static StrategyContext momentumBreakoutBullish() {
        return new StrategyContext(
            "TEST", 110,
            new TrendFeatures(
                new Structure("BOS_BULLISH", "UPTREND", 108.0, 95.0),
                new PriceVsMa(2, true),
                new PriceVsMa(5, true),
                new MovingAverages(105.0, 100.0, 95.0),
                new Dmi(30, 15, 28)),
            new MomentumFeatures(65, 1.5, 70.0, new Macd(1.2, 0.8)),
            new VolatilityFeatures("EXPANDING", 2, new Keltner(112, 98, 105)),
            new VolumeFeatures(2.1, new Vwap(1.2), 0.15, true),
            new PriceActionFeatures("BULLISH_ENGULFING", false),
            new SupportResistanceFeatures(new Nearest(new Level(100, -9.1), new Level(118, 7.3))),
            new RegimeResult("BULLISH_TREND", "TRENDING", 72),
            new MarketContextResult(
                new Sector(new SectorTrend(new RegimeResult("BULLISH_TREND", "TRENDING", 60))),
                new RelativeStrength(1.8))
        );
    }

    static StrategyContext momentumBreakoutBearish() {
        return new StrategyContext(
            "TEST", 90,
            new TrendFeatures(
                new Structure("BOS_BEARISH", "DOWNTREND", 105.0, 92.0),
                new PriceVsMa(-2, false),
                new PriceVsMa(-5, false),
                new MovingAverages(95.0, 100.0, 105.0),
                new Dmi(15, 30, 28)),
            new MomentumFeatures(35, -1.5, 30.0, new Macd(-1.2, -0.8)),
            new VolatilityFeatures("EXPANDING", 2, new Keltner(102, 88, 95)),
            new VolumeFeatures(2.1, new Vwap(-1.2), -0.15, true),
            new PriceActionFeatures("BEARISH_ENGULFING", false),
            new SupportResistanceFeatures(new Nearest(new Level(82, -8.9), new Level(100, 11.1))),
            new RegimeResult("BEARISH_TREND", "TRENDING", 72),
            new MarketContextResult(
                new Sector(new SectorTrend(new RegimeResult("BEARISH_TREND", "TRENDING", 60))),
                new RelativeStrength(-1.8))
        );
    }

    static StrategyContext rangingNeutral() {
        return new StrategyContext(
            "TEST", 100,
            new TrendFeatures(
                new Structure(null, null, 105.0, 95.0),
                new PriceVsMa(0.1, true),
                new PriceVsMa(0.2, true),
                new MovingAverages(100.0, 99.0, 98.0),
                new Dmi(20, 20, 15)),
            new MomentumFeatures(28, 0.1, 15.0, new Macd(0.1, 0.1)),
            new VolatilityFeatures("CONTRACTING", 1, new Keltner(103, 97, 100)),
            new VolumeFeatures(0.8, new Vwap(0.1), 0.02, false),
            new PriceActionFeatures("HAMMER", true),
            new SupportResistanceFeatures(new Nearest(new Level(96, -1), new Level(105, 5))),
            new RegimeResult("SIDEWAYS_RANGE", "RANGING", 10),
            new MarketContextResult(new Sector(null), null)
        );
    }
}
