/**
 * Phase 26 remediation — Alpaca clientOrderId, robustness gates, benchmark honesty, ingest flags.
 */
import { describe, it, expect } from 'vitest';
import { buildReplayPerformance } from '../replay/replayReport';
import { runCoreRobustness, applyRobustnessGates } from './coreRobustness';
import { emptyEvidence, deriveLifecycleStatus } from './promotionEngine';
import { markParquetBytesWritten, writeDatasetSidecar } from './parquetStore';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalDataset } from './ohlcvTypes';

describe('Phase 26 production remediation', () => {
  it('buildReplayPerformance marks SPY buy-hold OK when PIT benchmark bars supplied', () => {
    const report = buildReplayPerformance({
      startingCapital: 100000,
      endingCapital: 101000,
      grossPnl: 1000,
      fees: 1,
      slippage: 2,
      maxDrawdown: 10,
      maxDrawdownPct: 0.01,
      tradePnls: [10],
      buyTrades: 1,
      sellTrades: 1,
      noTrade: {},
      costProfile: 'Base',
      equityCurve: [{ t: 1, equity: 100000, cash: 50000 }],
      trades: [],
      benchmarkBars: [
        { timestamp: 1, close: 100 },
        { timestamp: 2, close: 110 },
      ],
    });
    expect(report.benchmark.status).toBe('OK');
    expect(report.benchmark.buyAndHoldReturnPct).toBe(10);
    expect(report.executionModel).toBe('NEXT_BAR_OPEN');
  });

  it('buildReplayPerformance leaves benchmark UNAVAILABLE without bars (no fabrication)', () => {
    const report = buildReplayPerformance({
      startingCapital: 100000,
      endingCapital: 100000,
      grossPnl: 0,
      fees: 0,
      slippage: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      tradePnls: [],
      buyTrades: 0,
      sellTrades: 0,
      noTrade: {},
      costProfile: 'Base',
      equityCurve: [],
      trades: [],
      benchmarkBars: null,
    });
    expect(report.benchmark.status).toBe('UNAVAILABLE');
    expect(report.benchmark.buyAndHoldReturnPct).toBeNull();
  });

  it('runCoreRobustness always returns evidence gates (false when insufficient)', () => {
    const report = runCoreRobustness([], []);
    expect(report.gates.monteCarloPass).toBe(false);
    expect(report.gates.permutationPass).toBe(false);
    expect(report.gates.costStressPass).toBe(false);
    expect(report.label).toBe('INSUFFICIENT_SAMPLE');
    const e = applyRobustnessGates(emptyEvidence('MOMENTUM_BREAKOUT'), report);
    expect(e.monteCarloPass).toBe(false);
    expect(deriveLifecycleStatus(e)).toBe('UNTESTED');
  });

  it('markParquetBytesWritten flips sidecar only when file exists', () => {
    const prev = process.env.ARGUS_WRITE_RESEARCH_PARQUET;
    const prevDir = process.env.ARGUS_RESEARCH_DIR;
    const tmp = join(process.cwd(), 'data', 'research_test_p26_' + process.pid);
    process.env.ARGUS_WRITE_RESEARCH_PARQUET = 'true';
    process.env.ARGUS_RESEARCH_DIR = tmp;
    try {
      mkdirSync(tmp, { recursive: true });
      const ds: CanonicalDataset = {
        schemaVersion: 1,
        datasetId: 'TEST_P26',
        symbol: 'SPY',
        timezone: 'America/New_York',
        frequency: '1Day',
        adjustmentPolicy: 'raw',
        missingBarPolicy: 'drop',
        duplicatePolicy: 'keep_last',
        source: 'unit',
        sourceVersion: 'v1',
        market: 'US',
        startTimestamp: 1,
        endTimestamp: 2,
        qualityStatus: 'GREEN',
        provenance: 'REAL_MARKET_DATA',
        bars: [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
      };
      writeDatasetSidecar(ds, { parquetBytesWritten: false });
      expect(markParquetBytesWritten('TEST_P26')).toBe(false);
      writeFileSync(join(tmp, 'TEST_P26.parquet'), 'not-real-parquet-bytes');
      expect(markParquetBytesWritten('TEST_P26')).toBe(true);
      const meta = JSON.parse(readFileSync(join(tmp, 'TEST_P26.meta.json'), 'utf8'));
      expect(meta.parquetBytesWritten).toBe(true);
    } finally {
      process.env.ARGUS_WRITE_RESEARCH_PARQUET = prev;
      process.env.ARGUS_RESEARCH_DIR = prevDir;
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('Alpaca orders mapper contract documents clientOrderId field (source check)', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(join(process.cwd(), 'src/brokers/AlpacaBroker.ts'), 'utf8'),
    );
    expect(src).toMatch(/async orders\(\)/);
    expect(src).toMatch(/clientOrderId:\s*o\.client_order_id/);
  });
});
