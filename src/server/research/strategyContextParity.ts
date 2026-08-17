/**
 * Strategy-context feature parity: scalar indicators shared by Quant Signal / Regime / WFO adapters.
 * Research-only. Not full StrategyContext.evaluate() parity. Not a live path.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { rsiEngine } from '../engines/RSIEngine';
import { macdEngine } from '../engines/MACDEngine';
import { calculateDMI, detectMarketStructure } from '../quant/indicators/trend';
import { calculateStochasticRSI, detectPriceOscillatorDivergence } from '../quant/indicators/momentum';
import { keltnerChannels } from '../quant/indicators/volatility';
import { classifyRegime } from '../quant/RegimeEngine';
import type { Bar } from '../engines/backtest/HistoricalDataGateway';

export const PARITY_ABS_TOLERANCE = 1e-4;

export interface ParityBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StrategyContextParityScalars {
  rsi: number;
  macd: { macd: number; signal: number; histogram: number };
  dmi: { plusDI: number; minusDI: number; adx: number } | null;
  stochasticRSI: number | null;
  keltner: { middle: number; upper: number; lower: number } | null;
  structure: { trend: string; event: string };
  macdDivergenceKind: string | null;
  regime: {
    regime: string;
    confidence: number;
    trendStrength: number;
    volatility: string;
    marketStructure: string;
    insufficientData: boolean;
  };
}

export interface StrategyContextParitySample {
  provenance: 'UNIT_FIXTURE';
  fullStrategyParity: false;
  note: string;
  bars: ParityBar[];
  expected: StrategyContextParityScalars;
}

/** Deterministic synthetic OHLC with enough length for SMA200 / regimeMinBars / DMI. */
export function buildParityBars(count = 220): ParityBar[] {
  const bars: ParityBar[] = [];
  let px = 100;
  const dayMs = 86_400_000;
  const start = Date.UTC(2020, 0, 2);
  for (let i = 0; i < count; i++) {
    // Mild uptrend + periodic pullbacks so DMI/structure/regime are non-trivial.
    const wave = Math.sin(i / 11) * 1.8 + Math.cos(i / 7) * 0.9;
    const drift = 0.12;
    const open = px;
    const close = Math.max(1, open + drift + wave * 0.15);
    const high = Math.max(open, close) + 0.35 + Math.abs(wave) * 0.05;
    const low = Math.min(open, close) - 0.35 - Math.abs(wave) * 0.04;
    const volume = 1_000_000 + ((i * 17_000) % 500_000);
    bars.push({
      timestamp: start + i * dayMs,
      open: round6(open),
      high: round6(high),
      low: round6(low),
      close: round6(close),
      volume,
    });
    px = close;
  }
  return bars;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function trailingMacdHistogram(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const m = macdEngine.calculate(slice);
    out.push(m.histogram);
  }
  return out;
}

export function computeStrategyContextParity(bars: ParityBar[]): StrategyContextParityScalars {
  const mapped: Bar[] = bars.map((b) => ({ ...b }));
  const closes = mapped.map((b) => b.close);
  const highs = mapped.map((b) => b.high);
  const lows = mapped.map((b) => b.low);
  const rsi = rsiEngine.calculate(closes);
  const macd = macdEngine.calculate(closes);
  const dmi = calculateDMI(highs, lows, closes);
  const stochasticRSI = calculateStochasticRSI(closes);
  const keltner = keltnerChannels(highs, lows, closes);
  const structure = detectMarketStructure(mapped);
  const macdDiv = detectPriceOscillatorDivergence(closes, trailingMacdHistogram(closes));
  const regime = classifyRegime(mapped);
  return {
    rsi,
    macd: { macd: macd.macd, signal: macd.signal, histogram: macd.histogram },
    dmi: dmi ? { plusDI: dmi.plusDI, minusDI: dmi.minusDI, adx: dmi.adx } : null,
    stochasticRSI,
    keltner,
    structure: { trend: structure.trend, event: structure.event },
    macdDivergenceKind: macdDiv.kind,
    regime: {
      regime: regime.regime,
      confidence: regime.confidence,
      trendStrength: regime.trendStrength,
      volatility: regime.volatility,
      marketStructure: regime.marketStructure,
      insufficientData: regime.insufficientData,
    },
  };
}

export function buildParityGoldenSample(barCount = 220): StrategyContextParitySample {
  const bars = buildParityBars(barCount);
  return {
    provenance: 'UNIT_FIXTURE',
    fullStrategyParity: false,
    note: 'Feature-level scalars for TS↔Python parity. Not StrategyContext.evaluate() byte-identity. Not an edge.',
    bars,
    expected: computeStrategyContextParity(bars),
  };
}

export function defaultParityFixturePath(cwd = process.cwd()): string {
  return join(cwd, 'tests', 'fixtures', 'parity_golden_sample.json');
}

export function writeParityGoldenSample(path = defaultParityFixturePath()): StrategyContextParitySample {
  const sample = buildParityGoldenSample();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
  return sample;
}

export type ParityDiffRow = {
  field: string;
  ts: number | string | null;
  py: number | string | null;
  delta: number | null;
  ok: boolean;
};

export function compareParityScalars(
  expected: StrategyContextParityScalars,
  actual: StrategyContextParityScalars,
  tol = PARITY_ABS_TOLERANCE,
): { ok: boolean; rows: ParityDiffRow[] } {
  const rows: ParityDiffRow[] = [];
  const num = (field: string, ts: number | null | undefined, py: number | null | undefined) => {
    const a = ts ?? null;
    const b = py ?? null;
    const delta = a == null || b == null ? (a === b ? 0 : null) : Math.abs(a - b);
    const ok = a == null && b == null ? true : a != null && b != null && delta! <= tol;
    rows.push({ field, ts: a, py: b, delta, ok });
  };
  const cat = (field: string, ts: string | null | undefined, py: string | null | undefined) => {
    const ok = (ts ?? null) === (py ?? null);
    rows.push({ field, ts: ts ?? null, py: py ?? null, delta: ok ? 0 : null, ok });
  };

  num('rsi', expected.rsi, actual.rsi);
  num('macd.macd', expected.macd.macd, actual.macd.macd);
  num('macd.signal', expected.macd.signal, actual.macd.signal);
  num('macd.histogram', expected.macd.histogram, actual.macd.histogram);
  num('dmi.plusDI', expected.dmi?.plusDI ?? null, actual.dmi?.plusDI ?? null);
  num('dmi.minusDI', expected.dmi?.minusDI ?? null, actual.dmi?.minusDI ?? null);
  num('dmi.adx', expected.dmi?.adx ?? null, actual.dmi?.adx ?? null);
  num('stochasticRSI', expected.stochasticRSI, actual.stochasticRSI);
  num('keltner.middle', expected.keltner?.middle ?? null, actual.keltner?.middle ?? null);
  num('keltner.upper', expected.keltner?.upper ?? null, actual.keltner?.upper ?? null);
  num('keltner.lower', expected.keltner?.lower ?? null, actual.keltner?.lower ?? null);
  cat('structure.trend', expected.structure.trend, actual.structure.trend);
  cat('structure.event', expected.structure.event, actual.structure.event);
  cat('macdDivergenceKind', expected.macdDivergenceKind, actual.macdDivergenceKind);
  cat('regime.regime', expected.regime.regime, actual.regime.regime);
  num('regime.confidence', expected.regime.confidence, actual.regime.confidence);
  num('regime.trendStrength', expected.regime.trendStrength, actual.regime.trendStrength);
  cat('regime.volatility', expected.regime.volatility, actual.regime.volatility);
  cat('regime.marketStructure', expected.regime.marketStructure, actual.regime.marketStructure);
  cat(
    'regime.insufficientData',
    String(expected.regime.insufficientData),
    String(actual.regime.insufficientData),
  );

  return { ok: rows.every((r) => r.ok), rows };
}
