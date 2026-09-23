import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { classifyGate25Detail } from './extendedHoursSpreadReport';

describe('classifyGate25Detail (pure, 2026-09-23 extended-hours spread report)', () => {
  it('classifies each real ExtendedHoursExecutionPolicy.ts detail shape correctly', () => {
    expect(classifyGate25Detail(true, { skipped: true, reason: 'not an extended-hours session' })).toBe('NOT_APPLICABLE');
    expect(classifyGate25Detail(true, { skipped: true, reason: 'extended-hours execution disabled' })).toBe('NOT_APPLICABLE');
    expect(classifyGate25Detail(false, { skipped: false, brokerExtendedHoursCapable: false })).toBe('BROKER_UNSUPPORTED');
    expect(classifyGate25Detail(false, { skipped: false, quoteAgeMs: null, maxQuoteAgeMs: 900000 })).toBe('STALE_QUOTE');
    expect(classifyGate25Detail(false, { skipped: false, spreadBps: null })).toBe('NO_SPREAD_DATA');
    expect(classifyGate25Detail(false, { skipped: false, spreadBps: 80, maxSpreadBps: 50 })).toBe('SPREAD_TOO_WIDE');
    expect(classifyGate25Detail(false, { skipped: false, avgDailyVolumeShares: null })).toBe('NO_LIQUIDITY_DATA');
    expect(classifyGate25Detail(false, { skipped: false, avgDailyVolumeShares: 1000, minAvgDailyVolumeShares: 500000 })).toBe('INSUFFICIENT_LIQUIDITY');
    expect(classifyGate25Detail(false, { skipped: false, notionalDollars: 2000, maxNotionalDollars: 1000 })).toBe('NOTIONAL_CAP');
    expect(classifyGate25Detail(true, { skipped: false, quoteAgeMs: 100, spreadBps: 10, avgDailyVolumeShares: 1_000_000, notionalDollars: 500 })).toBe('PASSED');
    expect(classifyGate25Detail(false, null)).toBe('UNKNOWN');
    expect(classifyGate25Detail(false, { somethingUnexpected: true })).toBe('UNKNOWN');
  });
});

describe('buildExtendedHoursSpreadReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./extendedHoursSpreadReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_eh_spread_report_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./extendedHoursSpreadReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('computes real classification counts, rates, and per-symbol breakdown from persisted risk_gate_results, excluding replay-tagged rows', async () => {
    const sinceIso = '2026-09-23T00:00:00.000Z';
    // Real, reproduced pattern: 2 TSLA NO_SPREAD_DATA (the actual forensic finding), 1 MSFT PASSED,
    // 1 AAPL STALE_QUOTE, 1 replay row (must be excluded regardless of its own gate result).
    await db.insert(schema.riskAssessments).values([
      { traceId: 'trace-tsla-1', symbol: 'TSLA', side: 'BUY', approved: false, rejectionGate: 'extended_hours_execution_policy', maxQuantity: 0, createdAt: '2026-09-23T09:17:10.000Z' },
      { traceId: 'trace-tsla-2', symbol: 'TSLA', side: 'BUY', approved: false, rejectionGate: 'extended_hours_execution_policy', maxQuantity: 0, createdAt: '2026-09-23T09:20:00.000Z' },
      { traceId: 'trace-msft-1', symbol: 'MSFT', side: 'BUY', approved: true, maxQuantity: 5, createdAt: '2026-09-23T10:00:00.000Z' },
      { traceId: 'trace-aapl-1', symbol: 'AAPL', side: 'BUY', approved: false, rejectionGate: 'extended_hours_execution_policy', maxQuantity: 0, createdAt: '2026-09-23T10:05:00.000Z' },
      { traceId: 'replay-xyz-1712000000000-NVDA-SELL-x', symbol: 'NVDA', side: 'SELL', approved: false, rejectionGate: 'extended_hours_execution_policy', maxQuantity: 0, createdAt: '2026-09-23T10:10:00.000Z' },
    ]);
    await db.insert(schema.riskGateResults).values([
      { traceId: 'trace-tsla-1', gateName: 'extended_hours_execution_policy', sequence: 25, passed: false, detail: JSON.stringify({ skipped: false, spreadBps: null }) },
      { traceId: 'trace-tsla-2', gateName: 'extended_hours_execution_policy', sequence: 25, passed: false, detail: JSON.stringify({ skipped: false, spreadBps: null }) },
      { traceId: 'trace-msft-1', gateName: 'extended_hours_execution_policy', sequence: 25, passed: true, detail: JSON.stringify({ skipped: false, quoteAgeMs: 100, spreadBps: 5, avgDailyVolumeShares: 2_000_000, notionalDollars: 300 }) },
      { traceId: 'trace-aapl-1', gateName: 'extended_hours_execution_policy', sequence: 25, passed: false, detail: JSON.stringify({ skipped: false, quoteAgeMs: null, maxQuoteAgeMs: 900000 }) },
      { traceId: 'replay-xyz-1712000000000-NVDA-SELL-x', gateName: 'extended_hours_execution_policy', sequence: 25, passed: false, detail: JSON.stringify({ skipped: false, spreadBps: null }) },
    ]);

    const report = await mod.buildExtendedHoursSpreadReport(sinceIso);

    expect(report.totalApplicableEvaluations).toBe(4); // excludes the replay row
    expect(report.classificationCounts.NO_SPREAD_DATA).toBe(2);
    expect(report.classificationCounts.PASSED).toBe(1);
    expect(report.classificationCounts.STALE_QUOTE).toBe(1);
    // quoteAvailabilityRate = (4 - 1 stale) / 4 = 0.75
    expect(report.quoteAvailabilityRate).toBeCloseTo(0.75, 5);
    // bidAskCompletenessRate = (PASSED+TOO_WIDE) / (applicable - stale) = 1 / 3
    expect(report.bidAskCompletenessRate).toBeCloseTo(1 / 3, 5);
    expect(report.staleQuoteRate).toBeCloseTo(0.25, 5);

    const tsla = report.bySymbol.find((s) => s.symbol === 'TSLA');
    expect(tsla?.classificationCounts.NO_SPREAD_DATA).toBe(2);
    expect(report.knownGaps.length).toBeGreaterThan(0);
  });

  it('returns null rates (never fabricated 0) when there are zero applicable evaluations in the window', async () => {
    const report = await mod.buildExtendedHoursSpreadReport('2099-01-01T00:00:00.000Z');
    expect(report.totalApplicableEvaluations).toBe(0);
    expect(report.quoteAvailabilityRate).toBeNull();
    expect(report.bidAskCompletenessRate).toBeNull();
    expect(report.staleQuoteRate).toBeNull();
  });
});
