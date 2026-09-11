package io.argus.quantcore.server;

import io.argus.quantcore.backtest.engine.Bar;
import io.argus.quantcore.features.MarketContext;
import io.argus.quantcore.features.MomentumFeatures;
import io.argus.quantcore.features.PriceActionFeatures;
import io.argus.quantcore.features.RegimeEngine;
import io.argus.quantcore.features.SupportResistanceFeatures;
import io.argus.quantcore.features.TrendFeatures;
import io.argus.quantcore.features.VolatilityFeatures;
import io.argus.quantcore.features.VolumeFeatures;
import io.argus.quantcore.strategy.types.StrategyContext;

import java.util.List;

/**
 * Closes the gap found 2026-09-10 (docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md §0):
 * {@code io.argus.quantcore.features.*} (real, byte-for-byte-ported, parity-tested feature math)
 * and {@code strategy.types.StrategyContext} (the 5 CORE strategies' own, separately-defined
 * nested record shapes) existed side by side with zero code connecting them. This class is that
 * connection — it computes every feature from the caller-supplied {@code Bar[]} using
 * {@code features.*} + {@code MomentumFeatures} (never TS-precomputed values) and maps the results
 * into {@code StrategyContext}'s nested records.
 *
 * Field-shape/ordering mismatches found and handled explicitly (not positional copies — several
 * {@code features.*} records use a different field order or a superset of fields than the
 * corresponding {@code StrategyContext} nested record):
 * - {@code TrendFeatures.MarketStructureResult(trend, event, ...)} vs
 *   {@code StrategyContext.Structure(event, trend, ...)} — order swapped.
 * - {@code TrendFeatures.PriceVsMA(diff, diffPct, above)} vs
 *   {@code StrategyContext.PriceVsMa(diffPct, above)} — {@code diff} dropped.
 * - {@code VolatilityFeatures.Keltner(middle, upper, lower)} vs
 *   {@code StrategyContext.Keltner(upper, lower, middle)} — order differs.
 * - {@code SupportResistanceFeatures.Nearest(nearestResistance, nearestSupport)} vs
 *   {@code StrategyContext.Nearest(nearestSupport, nearestResistance)} — order swapped.
 * - {@code SupportResistanceFeatures.LevelDistance(level, abs, pct)} vs
 *   {@code StrategyContext.Level(level, pct)} — {@code abs} dropped.
 * - {@code VolumeFeatures.VwapContext(vwap, distancePct, slopePct, event)} vs
 *   {@code StrategyContext.Vwap(distancePct)} — only {@code distancePct} carried over.
 *
 * marketContext is optional: when no benchmark bars are supplied, every nested field is null
 * (never fabricated) — matches every other "insufficient data" path in this codebase. Momentum's
 * two previously-missing fields (roc, stochasticRSI) are now real (MomentumFeatures.java, added
 * the same day as this adapter), not approximated.
 */
public final class FeaturesToStrategyContextAdapter {

    private FeaturesToStrategyContextAdapter() {
    }

    /** Optional benchmark inputs for marketContext — pass null for any/all to get an honest
     *  null marketContext.sector/relativeStrengthVsSPY rather than a fabricated value. Only
     *  MomentumBreakout reads marketContext among the 5 CORE strategies. */
    public record BenchmarkBars(
        MarketContext.BenchmarkInput spy,
        MarketContext.BenchmarkInput qqq,
        MarketContext.BenchmarkInput iwm,
        String sectorName,
        String sectorEtf,
        MarketContext.BenchmarkInput sector
    ) {
    }

    public static StrategyContext build(String symbol, List<Bar> bars, String timeframe, BenchmarkBars benchmarks) {
        double currentPrice = bars.isEmpty() ? 0 : bars.get(bars.size() - 1).close();

        TrendFeatures.Result trend = TrendFeatures.computeTrendFeatures(bars);
        MomentumFeatures.Result momentum = MomentumFeatures.computeMomentumFeatures(bars);
        VolatilityFeatures.Result volatility = VolatilityFeatures.computeVolatilityFeatures(bars);
        VolumeFeatures.Result volume = VolumeFeatures.computeVolumeFeatures(bars);
        PriceActionFeatures.Result priceAction = PriceActionFeatures.computePriceActionFeatures(bars);
        SupportResistanceFeatures.Result supportResistance = SupportResistanceFeatures.computeSupportResistanceFeatures(bars);
        RegimeEngine.Result regime = RegimeEngine.classifyRegime(bars);

        StrategyContext.MarketContextResult marketContext = benchmarks == null
            ? new StrategyContext.MarketContextResult(null, null)
            : mapMarketContext(MarketContext.getMarketContext(bars, timeframe,
                benchmarks.spy(), benchmarks.qqq(), benchmarks.iwm(),
                benchmarks.sectorName(), benchmarks.sectorEtf(), benchmarks.sector()));

        return new StrategyContext(
            symbol,
            currentPrice,
            mapTrend(trend),
            mapMomentum(momentum),
            mapVolatility(volatility),
            mapVolume(volume),
            mapPriceAction(priceAction),
            mapSupportResistance(supportResistance),
            regime == null ? null : new StrategyContext.RegimeResult(regime.regime(), regime.marketStructure(), regime.trendStrength()),
            marketContext
        );
    }

    private static StrategyContext.TrendFeatures mapTrend(TrendFeatures.Result r) {
        var structure = r.structure() == null ? null
            : new StrategyContext.Structure(r.structure().event(), r.structure().trend(),
                r.structure().lastSwingHigh(), r.structure().lastSwingLow());
        var mas = r.movingAverages() == null ? null
            : new StrategyContext.MovingAverages(r.movingAverages().sma20(), r.movingAverages().sma50(), r.movingAverages().sma200());
        var dmi = r.dmi() == null ? null : new StrategyContext.Dmi(r.dmi().plusDI(), r.dmi().minusDI(), r.dmi().adx());
        return new StrategyContext.TrendFeatures(
            structure,
            mapPriceVsMa(r.priceVsSMA20()),
            mapPriceVsMa(r.priceVsSMA200()),
            mas,
            dmi
        );
    }

    private static StrategyContext.PriceVsMa mapPriceVsMa(TrendFeatures.PriceVsMA p) {
        return p == null ? null : new StrategyContext.PriceVsMa(p.diffPct(), p.above());
    }

    private static StrategyContext.MomentumFeatures mapMomentum(MomentumFeatures.Result m) {
        return new StrategyContext.MomentumFeatures(m.rsi(), m.roc(), m.stochasticRSI(),
            new StrategyContext.Macd(m.macd(), m.macdSignal()));
    }

    private static StrategyContext.VolatilityFeatures mapVolatility(VolatilityFeatures.Result v) {
        var keltner = v.keltner() == null ? null
            : new StrategyContext.Keltner(v.keltner().upper(), v.keltner().lower(), v.keltner().middle());
        return new StrategyContext.VolatilityFeatures(v.regime(), v.atr(), keltner);
    }

    private static StrategyContext.VolumeFeatures mapVolume(VolumeFeatures.Result v) {
        var vwap = new StrategyContext.Vwap(v.vwap() == null ? null : v.vwap().distancePct());
        return new StrategyContext.VolumeFeatures(v.relativeVolume(), vwap, v.cmf(), v.isSpike());
    }

    private static StrategyContext.PriceActionFeatures mapPriceAction(PriceActionFeatures.Result p) {
        return new StrategyContext.PriceActionFeatures(p.candlestick(), p.consolidating());
    }

    private static StrategyContext.SupportResistanceFeatures mapSupportResistance(SupportResistanceFeatures.Result s) {
        var nearest = s.nearest() == null ? null
            : new StrategyContext.Nearest(mapLevel(s.nearest().nearestSupport()), mapLevel(s.nearest().nearestResistance()));
        return new StrategyContext.SupportResistanceFeatures(nearest);
    }

    private static StrategyContext.Level mapLevel(SupportResistanceFeatures.LevelDistance l) {
        return l == null ? null : new StrategyContext.Level(l.level(), l.pct());
    }

    private static StrategyContext.MarketContextResult mapMarketContext(MarketContext.Result r) {
        StrategyContext.SectorTrend sectorTrend = (r.sector() == null || r.sector().trend() == null || r.sector().trend().regime() == null)
            ? null
            : new StrategyContext.SectorTrend(new StrategyContext.RegimeResult(
                r.sector().trend().regime().regime(), r.sector().trend().regime().marketStructure(), r.sector().trend().regime().trendStrength()));
        StrategyContext.Sector sector = r.sector() == null ? null : new StrategyContext.Sector(sectorTrend);
        StrategyContext.RelativeStrength rs = r.relativeStrengthVsSPY() == null
            ? null : new StrategyContext.RelativeStrength(r.relativeStrengthVsSPY().relativeStrengthPct());
        return new StrategyContext.MarketContextResult(sector, rs);
    }
}
