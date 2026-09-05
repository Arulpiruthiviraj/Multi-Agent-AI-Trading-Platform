package io.argus.quantcore.features;

import io.argus.quantcore.backtest.engine.Bar;

import java.util.ArrayList;
import java.util.List;

/**
 * Ported from src/server/quant/MarketContext.ts's getMarketContext (JMIG-001) - restricted to the
 * PURE computational core. The real TS function's bar-fetching is already injectable via its own
 * {@code BarsFetcher} type specifically so callers/tests can supply already-fetched bars instead
 * of a live network/DB call (see MarketContext.test.ts's own {@code fakeFetcher}); this port takes
 * that same shape one step further and requires every bar array as a plain input, doing no
 * fetching of its own at all - consistent with quant-core-java being a computational engine with
 * zero broker/DB/network access of its own.
 *
 * Sector name/ETF resolution (PositionSizing.ts's {@code getSector}/{@code SECTOR_MAP}) is
 * likewise a caller-supplied input here ({@code sectorName}/{@code sectorEtf}), not ported - out
 * of JMIG-001's stated file scope (RegimeEngine/MarketContext/trend/volatility/priceAction/volume/
 * supportResistance only; PositionSizing.ts is a different file).
 */
public final class MarketContext {
    private MarketContext() {
    }

    /** Models one benchmark's real fetch outcome: {@code bars} populated (success, possibly
     *  empty), or {@code fetchError} populated (the real TS try/catch's error message) - mirrors
     *  getMarketContext's two real failure branches ("no bars returned" vs "fetch failed: ..."). */
    public record BenchmarkInput(List<Bar> bars, String fetchError) {
        public static BenchmarkInput ok(List<Bar> bars) {
            return new BenchmarkInput(bars, null);
        }

        public static BenchmarkInput failed(String error) {
            return new BenchmarkInput(null, error);
        }
    }

    public record BenchmarkTrend(String symbol, RegimeEngine.Result regime, String source) {
    }

    public record RelativeStrength(String vsSymbol, Double periodPct, Double benchmarkPeriodPct,
                                    Double relativeStrengthPct, Double correlation, Double beta, String source) {
    }

    public record Sector(String name, String etf, BenchmarkTrend trend) {
    }

    public record Breadth(boolean available, String reason) {
    }

    public record Result(BenchmarkTrend spy, BenchmarkTrend qqq, BenchmarkTrend iwm, Sector sector,
                          RelativeStrength relativeStrengthVsSPY, RelativeStrength relativeStrengthVsSector,
                          Breadth breadth) {
    }

    static BenchmarkTrend benchmarkTrend(String symbol, String timeframe, BenchmarkInput input) {
        if (input.fetchError() != null) {
            return new BenchmarkTrend(symbol, null,
                "ohlcv_bars(alpaca):" + symbol + ":" + timeframe + " - fetch failed: " + input.fetchError());
        }
        if (input.bars() == null || input.bars().isEmpty()) {
            return new BenchmarkTrend(symbol, null, "ohlcv_bars(alpaca):" + symbol + ":" + timeframe + " - no bars returned");
        }
        return new BenchmarkTrend(symbol, RegimeEngine.classifyRegime(input.bars()), "ohlcv_bars(alpaca):" + symbol + ":" + timeframe);
    }

    static Double pctChange(List<Bar> bars) {
        if (bars.size() < 2) {
            return null;
        }
        double first = bars.get(0).close();
        if (first == 0) {
            return null;
        }
        return ((bars.get(bars.size() - 1).close() - first) / first) * 100;
    }

    static double[] toReturns(List<Bar> bars) {
        List<Double> rets = new ArrayList<>();
        for (int i = 1; i < bars.size(); i++) {
            double prevClose = bars.get(i - 1).close();
            if (prevClose != 0) {
                rets.add(bars.get(i).close() / prevClose - 1);
            }
        }
        double[] arr = new double[rets.size()];
        for (int i = 0; i < arr.length; i++) {
            arr[i] = rets.get(i);
        }
        return arr;
    }

    static RelativeStrength computeRelativeStrength(List<Bar> symbolBars, String benchmarkSymbol, String timeframe, BenchmarkInput benchmarkInput) {
        if (benchmarkInput.fetchError() != null || benchmarkInput.bars() == null
            || benchmarkInput.bars().isEmpty() || symbolBars.isEmpty()) {
            return null;
        }
        List<Bar> benchmarkBars = benchmarkInput.bars();

        Double periodPct = pctChange(symbolBars);
        Double benchmarkPeriodPct = pctChange(benchmarkBars);
        Double relativeStrengthPct = (periodPct != null && benchmarkPeriodPct != null) ? periodPct - benchmarkPeriodPct : null;

        double[] symbolReturns = toReturns(symbolBars);
        double[] benchReturns = toReturns(benchmarkBars);

        return new RelativeStrength(benchmarkSymbol, periodPct, benchmarkPeriodPct, relativeStrengthPct,
            StatisticsMath.correlation(symbolReturns, benchReturns, 20),
            StatisticsMath.beta(symbolReturns, benchReturns, 20),
            "ohlcv_bars(alpaca):" + benchmarkSymbol + ":" + timeframe);
    }

    /** Pure-core equivalent of getMarketContext - see this class's header for what's deliberately
     *  caller-supplied instead of fetched internally. */
    public static Result getMarketContext(List<Bar> symbolBars, String timeframe,
                                           BenchmarkInput spy, BenchmarkInput qqq, BenchmarkInput iwm,
                                           String sectorName, String sectorEtf, BenchmarkInput sector) {
        BenchmarkTrend spyTrend = benchmarkTrend("SPY", timeframe, spy);
        BenchmarkTrend qqqTrend = benchmarkTrend("QQQ", timeframe, qqq);
        BenchmarkTrend iwmTrend = benchmarkTrend("IWM", timeframe, iwm);

        BenchmarkTrend sectorTrend = sectorEtf != null ? benchmarkTrend(sectorEtf, timeframe, sector) : null;

        RelativeStrength relativeStrengthVsSPY = computeRelativeStrength(symbolBars, "SPY", timeframe, spy);
        RelativeStrength relativeStrengthVsSector = sectorEtf != null
            ? computeRelativeStrength(symbolBars, sectorEtf, timeframe, sector)
            : null;

        return new Result(spyTrend, qqqTrend, iwmTrend,
            new Sector(sectorName, sectorEtf, sectorTrend),
            relativeStrengthVsSPY, relativeStrengthVsSector,
            new Breadth(false, "No market-breadth data source (advance/decline, new highs/lows) exists in this codebase - not fabricated from the handful of symbols fetched here."));
    }
}
