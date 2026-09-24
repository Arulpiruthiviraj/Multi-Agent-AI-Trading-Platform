import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('quantEvidenceReport', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./quantEvidenceReport');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quant_evidence_report_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./quantEvidenceReport');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seedProducedEvent(producer: string, overrides: Record<string, any> = {}, ts = Date.now()) {
    const payload = {
      producer,
      engineVersion: 'schemaVersion=1',
      strategyId: null,
      methodologyFamily: 'TECHNICAL_ENSEMBLE',
      dataDependency: 'CANONICAL_BARS',
      timeHorizon: 'INTRADAY',
      direction: 'BUY',
      rawScore: { value: 0.7, provenance: 'REAL_VALUE' },
      normalizedScore: { value: 0.4, provenance: 'DERIVED' },
      confidence: { value: 0.65, provenance: 'REAL_VALUE' },
      predictedReturn: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      predictedVolatility: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      downsideRisk: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      upsidePotential: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      probabilityUp: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      probabilityDown: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      probabilityFlat: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      uncertainty: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      calibrationStatus: 'NOT_YET_CALIBRATED',
      calibrationSampleSize: { value: null, provenance: 'NOT_YET_CALIBRATED' },
      regime: { value: 'TRENDING', provenance: 'REAL_VALUE' },
      estimatedTransactionCostBps: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      netExpectedReturn: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      costQuality: 'NOT_APPLICABLE',
      netReturnAvailable: false,
      dataFreshness: { value: null, provenance: 'NULL_NOT_SUPPORTED' },
      inputCompleteness: { value: 0.8, provenance: 'DERIVED' },
      provenance: 'test fixture',
      ...overrides,
    };
    return db.insert(schema.observabilityEvents).values({
      id: `evt-${Math.random().toString(36).slice(2)}`,
      ts,
      level: 'INFO',
      category: 'AGENT',
      eventType: 'QUANT_EVIDENCE_PRODUCED',
      loggerName: 'argus',
      message: 'quant_evidence_produced',
      sessionId: 'sess-1',
      symbol: 'AAPL',
      payload: JSON.stringify(payload),
    });
  }

  function seedValidationFailedEvent(producer: string, ts = Date.now()) {
    return db.insert(schema.observabilityEvents).values({
      id: `evt-${Math.random().toString(36).slice(2)}`,
      ts,
      level: 'WARN',
      category: 'AGENT',
      eventType: 'QUANT_EVIDENCE_VALIDATION_FAILED',
      loggerName: 'argus',
      message: 'quant_evidence_validation_failed - event suppressed',
      sessionId: 'sess-1',
      symbol: 'AAPL',
      payload: JSON.stringify({ producer, reason: 'invalid_numeric_field:rawScore' }),
    });
  }

  it('returns an all-zero report when no QUANT_EVIDENCE_PRODUCED rows exist in the window', async () => {
    const report = await mod.buildQuantEvidenceReport(new Date('2020-01-01T00:00:00.000Z').toISOString());
    expect(report.totalProduced).toBe(0);
    expect(report.byProducer).toEqual([]);
  });

  it('aggregates per-producer counts, latest values, and supported/unsupported field fractions', async () => {
    const base = new Date('2026-09-23T14:00:00.000Z').getTime();
    await seedProducedEvent('JavaCoreEnsemble', {}, base);
    await seedProducedEvent('JavaCoreEnsemble', { confidence: { value: 0.8, provenance: 'REAL_VALUE' }, direction: 'SELL' }, base + 1000);
    await seedProducedEvent('JavaFactorComposite', { regime: { value: 'BULL_TRENDING', provenance: 'REAL_VALUE' } }, base + 2000);
    await seedValidationFailedEvent('JavaFactorComposite', base + 3000);

    const report = await mod.buildQuantEvidenceReport(new Date('2026-09-23T00:00:00.000Z').toISOString());
    expect(report.totalProduced).toBe(3);
    expect(report.totalValidationFailed).toBe(1);

    const coreRow = report.byProducer.find((p) => p.producer === 'JavaCoreEnsemble')!;
    expect(coreRow.count).toBe(2);
    // Latest row (base+1000) had direction SELL, confidence 0.8
    expect(coreRow.latestDirection).toBe('SELL');
    expect(coreRow.latestConfidence).toBe(0.8);
    expect(coreRow.supportedFieldFraction).toBeGreaterThan(0);
    expect(coreRow.unsupportedFieldFraction).toBeGreaterThan(0);

    const factorRow = report.byProducer.find((p) => p.producer === 'JavaFactorComposite')!;
    expect(factorRow.count).toBe(1);
    expect(factorRow.validationFailedCount).toBe(1);
  });

  it('excludes rows outside the requested window', async () => {
    await seedProducedEvent('OldWindowOnlyProducer', {}, new Date('2020-01-01T00:00:00.000Z').getTime());
    const report = await mod.buildQuantEvidenceReport(new Date('2026-01-01T00:00:00.000Z').toISOString());
    expect(report.byProducer.find((p) => p.producer === 'OldWindowOnlyProducer')).toBeUndefined();
  });

  it('formatQuantEvidenceReport produces readable text with no thrown errors on an empty report', () => {
    const text = mod.formatQuantEvidenceReport({ windowSinceIso: '2026-01-01T00:00:00.000Z', totalProduced: 0, totalValidationFailed: 0, byProducer: [] });
    expect(text).toContain('ARGUS QUANT EVIDENCE');
    expect(text).toContain('(no QUANT_EVIDENCE_PRODUCED rows in this window)');
  });
});
