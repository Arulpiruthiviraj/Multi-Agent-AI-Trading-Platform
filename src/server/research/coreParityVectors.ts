/**
 * CORE feature parity vectors: BOS / RVOL / Keltner / nearest S/R from the same TS engines
 * live Quant uses. VectorBT must match these numbers — not an SMA proxy.
 */
import { relativeVolume } from '../quant/indicators/volume';
import { keltnerChannels } from '../quant/indicators/volatility';
import { detectMarketStructure, detectSwingPoints } from '../quant/indicators/trend';
import { nearestSupportResistance } from '../quant/indicators/supportResistance';
import type { ResearchBar } from './ohlcvTypes';
import type { Bar } from '../engines/backtest/HistoricalDataGateway';

function toBar(b: ResearchBar): Bar {
  return { timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
}

export interface CoreParityVector {
  structureEvent: string;
  structureTrend: string;
  rvol: number | null;
  keltner: { middle: number; upper: number; lower: number } | null;
  nearestSupport: number | null;
  nearestResistance: number | null;
}

export function coreParityVector(bars: ResearchBar[]): CoreParityVector {
  const mapped = bars.map(toBar);
  const structure = detectMarketStructure(mapped);
  const swings = detectSwingPoints(mapped).slice(-10);
  const px = mapped.length ? mapped[mapped.length - 1].close : 0;
  const nearest = nearestSupportResistance(px, swings.map((s) => s.price));
  const highs = mapped.map((b) => b.high);
  const lows = mapped.map((b) => b.low);
  const closes = mapped.map((b) => b.close);
  const volumes = mapped.map((b) => b.volume);
  return {
    structureEvent: structure.event,
    structureTrend: structure.trend,
    rvol: relativeVolume(volumes),
    keltner: keltnerChannels(highs, lows, closes),
    nearestSupport: nearest.nearestSupport?.level ?? null,
    nearestResistance: nearest.nearestResistance?.level ?? null,
  };
}

export function vectorsMatch(a: CoreParityVector, b: CoreParityVector, tol = 1e-9): boolean {
  if (a.structureEvent !== b.structureEvent || a.structureTrend !== b.structureTrend) return false;
  if (a.nearestSupport !== b.nearestSupport && Math.abs((a.nearestSupport ?? 0) - (b.nearestSupport ?? 0)) > tol) return false;
  if (a.nearestResistance !== b.nearestResistance && Math.abs((a.nearestResistance ?? 0) - (b.nearestResistance ?? 0)) > tol) return false;
  if (a.rvol == null || b.rvol == null) {
    if (a.rvol !== b.rvol) return false;
  } else if (Math.abs(a.rvol - b.rvol) > tol) return false;
  if (!a.keltner || !b.keltner) return a.keltner == null && b.keltner == null;
  return (
    Math.abs(a.keltner.middle - b.keltner.middle) <= tol
    && Math.abs(a.keltner.upper - b.keltner.upper) <= tol
    && Math.abs(a.keltner.lower - b.keltner.lower) <= tol
  );
}

/** NEXT_BAR_OPEN qty=1 fills from identical long-only BUY signals — not BacktestEngine same-bar. */
export function nextOpenFillStats(
  bars: ResearchBar[],
  buyAtIndex: boolean[],
): { tradeCount: number; netPnl: number } {
  let long = false;
  let entry = 0;
  let tradeCount = 0;
  let netPnl = 0;
  for (let i = 0; i < bars.length - 1; i++) {
    const exec = bars[i + 1].open;
    if (buyAtIndex[i] && !long) {
      long = true;
      entry = exec;
    } else if (!buyAtIndex[i] && long) {
      netPnl += exec - entry;
      tradeCount += 1;
      long = false;
    }
  }
  return { tradeCount, netPnl };
}
