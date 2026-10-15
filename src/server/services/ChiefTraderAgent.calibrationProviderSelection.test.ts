import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * REGRESSION (2026-10-15 audit follow-up, nondeterministic calibration row choice): agent_confidence_calibration is keyed (agent, bucket, provider) and holds an
 * 'ALL' aggregate row plus per-provider rows (NewsAgent had up to four rows per bucket in production). calibrateConfidenceDetailed() selected rows[0] with no provider
 * filter and no ordering, so the decision confidence depended on physical row order. It must always read the 'ALL' aggregate, regardless of insertion order.
 */
describe('ChiefTraderAgent - calibration row selection is deterministic', () => {
  let tmpDbPath: string; let db: any; let sqliteDb: any; let schema: any; let ChiefTraderAgent: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_calprov_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ ChiefTraderAgent } = await import('./ChiefTraderAgent'));
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });

  it('reads the ALL aggregate even when per-provider rows for the same agent and bucket were inserted first', async () => {
    const now = new Date().toISOString();
    // per-provider rows (real production ids are UUIDs; digits sort BEFORE 'ALL' in the (agent,bucket,provider) unique index, so an unfiltered lookup returns them first); inserted first too with very different values, then the ALL aggregate
    await db.insert(schema.agentConfidenceCalibration).values({ agentName: 'NewsAgent', bucketLow: 0.8, bucketHigh: 0.9, wins: 5, losses: 45, calibratedConfidence: 0.2, provider: '4afb8961-0000-0000-0000-000000000001', lastEvaluated: now });
    await db.insert(schema.agentConfidenceCalibration).values({ agentName: 'NewsAgent', bucketLow: 0.8, bucketHigh: 0.9, wins: 1, losses: 2, calibratedConfidence: 0.7, provider: '271db452-0000-0000-0000-000000000002', lastEvaluated: now });
    await db.insert(schema.agentConfidenceCalibration).values({ agentName: 'NewsAgent', bucketLow: 0.8, bucketHigh: 0.9, wins: 60, losses: 20, calibratedConfidence: 0.74, provider: 'ALL', lastEvaluated: now });

    const agent = new ChiefTraderAgent();
    const detail = await (agent as any).calibrateConfidenceDetailed('NewsAgent', 0.85);
    expect(detail.decisionConfidence).toBeCloseTo(0.74, 6);
    expect(detail.sampleSize).toBe(80);
  });

  it('an agent whose only rows are per-provider (no ALL aggregate) is treated as having no calibration data, never as another provider\'s row', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.agentConfidenceCalibration).values({ agentName: 'OnlyProviderAgent', bucketLow: 0.7, bucketHigh: 0.8, wins: 3, losses: 40, calibratedConfidence: 0.1, provider: '4afb8961-0000-0000-0000-000000000001', lastEvaluated: now });
    const agent = new ChiefTraderAgent();
    const detail = await (agent as any).calibrateConfidenceDetailed('OnlyProviderAgent', 0.75);
    expect(detail.dataQuality).toBe('NO_CALIBRATION_DATA');
    expect(detail.decisionConfidence).toBeCloseTo(0.75, 6);
  });
});
