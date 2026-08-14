/**
 * ==========================================================
 * Module: MarketContext
 *
 * Purpose:
 * Phase 3 of the additive quant layer - SPY/QQQ/IWM trend, sector strength, and stock-vs-
 * benchmark/sector relative strength, using the SAME real historical data source everything else
 * in this codebase already uses (HistoricalDataGateway -> ohlcv_bars, Alpaca-backed) - no new
 * data provider is introduced. Every field in the returned object is explicitly source-tagged.
 *
 * Breadth metrics (advance/decline, new highs/lows, etc.) are NOT computed - no data source for
 * market-wide breadth exists anywhere in this codebase, and this module reports that honestly
 * (`breadth.available: false`) rather than fabricating one from the handful of symbols it happens
 * to fetch, per this plan's explicit "do not invent unavailable data" requirement.
 *
 * Sector proxy ETFs (XLK/XLF/etc.) are new to this module - PositionSizing.ts's existing
 * `SECTOR_MAP`/`getSector` (symbol -> sector NAME, used for its own concentration-cap gate) is
 * imported and reused as-is to look up a symbol's sector; this file only adds the NEW mapping
 * from sector name -> a representative sector ETF ticker, it does not touch PositionSizing.ts.
 * ==========================================================
 */
import { Bar, historicalDataGateway } from '../engines/backtest/HistoricalDataGateway';
import { getSector } from '../engines/PositionSizing';
import { classifyRegime, RegimeResult } from './RegimeEngine';
import { correlation, beta } from './statistics';

export const BENCHMARK_SYMBOLS = { broad: 'SPY', tech: 'QQQ', smallCap: 'IWM' } as const;

/** Representative sector ETF per GICS-ish sector name - matches PositionSizing.ts's own sector
 *  naming exactly (both must agree for `getSector(symbol)`'s result to look up correctly here). */
export const SECTOR_ETF_MAP: Record<string, string> = {
  'Technology': 'XLK',
  'Communication Services': 'XLC',
  'Consumer Discretionary': 'XLY',
  'Financials': 'XLF',
  'Energy': 'XLE',
  'Healthcare': 'XLV',
  'Consumer Staples': 'XLP',
  'Industrials': 'XLI',
};

export interface BenchmarkTrend {
  symbol: string;
  regime: RegimeResult | null; // null only if bars genuinely couldn't be fetched
  source: string;
}

export interface RelativeStrength {
  vsSymbol: string;
  periodPct: number | null; // symbol's own % change over the lookback window
  benchmarkPeriodPct: number | null;
  relativeStrengthPct: number | null; // symbol's periodPct minus the benchmark's - real outperformance/underperformance, not a fabricated score
  correlation: number | null;
  beta: number | null;
  source: string;
}

export interface MarketContextResult {
  spy: BenchmarkTrend;
  qqq: BenchmarkTrend;
  iwm: BenchmarkTrend;
  sector: { name: string | null; etf: string | null; trend: BenchmarkTrend | null };
  relativeStrengthVsSPY: RelativeStrength | null;
  relativeStrengthVsSector: RelativeStrength | null;
  breadth: { available: false; reason: string };
}

/** Injectable so tests never need a real Alpaca-backed DB fetch - production code (getMarketContext's
 *  default) goes through the real historicalDataGateway, identical to how BacktestEngine/RiskEngine
 *  already source real bars. */
export type BarsFetcher = (symbol: string, timeframe: string, startMs: number, endMs: number) => Promise<Bar[]>;

export const defaultBarsFetcher: BarsFetcher = async (symbol, timeframe, startMs, endMs) => {
  await historicalDataGateway.ensureBars(symbol, timeframe, startMs, endMs);
  return historicalDataGateway.getBars(symbol, timeframe, startMs, endMs);
};

async function benchmarkTrend(symbol: string, timeframe: string, startMs: number, endMs: number, fetchBars: BarsFetcher): Promise<BenchmarkTrend> {
  try {
    const bars = await fetchBars(symbol, timeframe, startMs, endMs);
    if (bars.length === 0) return { symbol, regime: null, source: `ohlcv_bars(alpaca):${symbol}:${timeframe} - no bars returned` };
    return { symbol, regime: classifyRegime(bars), source: `ohlcv_bars(alpaca):${symbol}:${timeframe}` };
  } catch (e: any) {
    return { symbol, regime: null, source: `ohlcv_bars(alpaca):${symbol}:${timeframe} - fetch failed: ${e.message}` };
  }
}

function pctChange(bars: Bar[]): number | null {
  if (bars.length < 2) return null;
  const first = bars[0].close;
  if (first === 0) return null;
  return ((bars[bars.length - 1].close - first) / first) * 100;
}

async function computeRelativeStrength(symbolBars: Bar[], benchmarkSymbol: string, timeframe: string, startMs: number, endMs: number, fetchBars: BarsFetcher): Promise<RelativeStrength | null> {
  try {
    const benchmarkBars = await fetchBars(benchmarkSymbol, timeframe, startMs, endMs);
    if (benchmarkBars.length === 0 || symbolBars.length === 0) return null;

    const periodPct = pctChange(symbolBars);
    const benchmarkPeriodPct = pctChange(benchmarkBars);
    const relativeStrengthPct = periodPct !== null && benchmarkPeriodPct !== null ? periodPct - benchmarkPeriodPct : null;

    const symbolCloses = symbolBars.map(b => b.close);
    const benchCloses = benchmarkBars.map(b => b.close);

    return {
      vsSymbol: benchmarkSymbol,
      periodPct,
      benchmarkPeriodPct,
      relativeStrengthPct,
      correlation: correlation(symbolCloses, benchCloses),
      beta: beta(symbolCloses, benchCloses),
      source: `ohlcv_bars(alpaca):${benchmarkSymbol}:${timeframe}`,
    };
  } catch {
    return null;
  }
}

/**
 * Full market-context assessment for `symbol` over `[startMs,endMs]`. `symbolBars` is passed in
 * (the caller - QuantSignalAgent - already fetched it for its own indicator computation; this
 * avoids a redundant fetch of the same symbol/range).
 */
export async function getMarketContext(
  symbol: string,
  symbolBars: Bar[],
  timeframe: string,
  startMs: number,
  endMs: number,
  fetchBars: BarsFetcher = defaultBarsFetcher
): Promise<MarketContextResult> {
  const [spy, qqq, iwm] = await Promise.all([
    benchmarkTrend(BENCHMARK_SYMBOLS.broad, timeframe, startMs, endMs, fetchBars),
    benchmarkTrend(BENCHMARK_SYMBOLS.tech, timeframe, startMs, endMs, fetchBars),
    benchmarkTrend(BENCHMARK_SYMBOLS.smallCap, timeframe, startMs, endMs, fetchBars),
  ]);

  const sectorName = getSector(symbol);
  const sectorEtf = sectorName ? SECTOR_ETF_MAP[sectorName] ?? null : null;
  const sectorTrend = sectorEtf ? await benchmarkTrend(sectorEtf, timeframe, startMs, endMs, fetchBars) : null;

  const [relativeStrengthVsSPY, relativeStrengthVsSector] = await Promise.all([
    computeRelativeStrength(symbolBars, BENCHMARK_SYMBOLS.broad, timeframe, startMs, endMs, fetchBars),
    sectorEtf ? computeRelativeStrength(symbolBars, sectorEtf, timeframe, startMs, endMs, fetchBars) : Promise.resolve(null),
  ]);

  return {
    spy, qqq, iwm,
    sector: { name: sectorName, etf: sectorEtf, trend: sectorTrend },
    relativeStrengthVsSPY,
    relativeStrengthVsSector,
    breadth: { available: false, reason: 'No market-breadth data source (advance/decline, new highs/lows) exists in this codebase - not fabricated from the handful of symbols fetched here.' },
  };
}
