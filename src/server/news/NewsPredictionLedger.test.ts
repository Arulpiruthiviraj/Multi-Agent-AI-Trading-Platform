import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real, DB-backed proof of Phase F5's prediction ledger: predictions are actually persisted (not
 * fabricated), referencePrice is honestly null when no live price is available, and the ledger
 * can be queried back per-symbol in recency order.
 */
describe('NewsPredictionLedger (Phase F5, real DB)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: any;
  let schema: typeof import('../db/schema');
  let recordNewsPrediction: typeof import('./NewsPredictionLedger').recordNewsPrediction;
  let listRecentNewsPredictions: typeof import('./NewsPredictionLedger').listRecentNewsPredictions;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_newspred_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb, db } = await import('../db'));
    schema = await import('../db/schema');
    ({ recordNewsPrediction, listRecentNewsPredictions } = await import('./NewsPredictionLedger'));
  });

  beforeEach(async () => {
    await db.delete(schema.newsPredictions);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function prediction(overrides: Partial<Parameters<typeof recordNewsPrediction>[0]> = {}) {
    return {
      clusterId: 'cluster_1',
      traceId: 'trace_1',
      symbol: 'AAPL',
      direction: 'BULLISH' as const,
      confidence: 82,
      expectedHorizon: 'INTRADAY' as const,
      referencePrice: 218.5,
      reasoning: 'Strong product announcement.',
      materiality: 'HIGH' as const,
      catalystType: 'PRODUCT' as const,
      riskLevel: 'LOW' as const,
      riskVeto: false,
      sourceCount: 2,
      modelSource: 'gemini-1.5-pro',
      ...overrides,
    };
  }

  it('persists a real prediction row, not a fabricated one', async () => {
    const id = await recordNewsPrediction(prediction());
    expect(id).toBeTruthy();

    const rows = await db.select().from(schema.newsPredictions);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe('AAPL');
    expect(rows[0].direction).toBe('BULLISH');
    expect(rows[0].confidence).toBe(82);
    expect(rows[0].referencePrice).toBe(218.5);
    expect(rows[0].modelSource).toBe('gemini-1.5-pro');
  });

  it('records a null referencePrice honestly when no live price was available, never a guessed number', async () => {
    await recordNewsPrediction(prediction({ referencePrice: null }));
    const rows = await db.select().from(schema.newsPredictions);
    expect(rows[0].referencePrice).toBeNull();
  });

  it('uppercases the symbol on write so case-insensitive lookups are reliable', async () => {
    await recordNewsPrediction(prediction({ symbol: 'aapl' }));
    const rows = await listRecentNewsPredictions('AAPL');
    expect(rows).toHaveLength(1);
  });

  it('listRecentNewsPredictions filters by symbol and orders newest-first', async () => {
    await recordNewsPrediction(prediction({ symbol: 'AAPL', traceId: 't1' }));
    await new Promise((r) => setTimeout(r, 5));
    await recordNewsPrediction(prediction({ symbol: 'AAPL', traceId: 't2' }));
    await recordNewsPrediction(prediction({ symbol: 'MSFT', traceId: 't3' }));

    const aaplRows = await listRecentNewsPredictions('AAPL');
    expect(aaplRows).toHaveLength(2);
    expect(aaplRows.every((r: any) => r.symbol === 'AAPL')).toBe(true);
    expect(aaplRows[0].traceId).toBe('t2'); // newest first
  });

  it('records the currently-configured newsAgentMode with every prediction', async () => {
    await recordNewsPrediction(prediction());
    const rows = await db.select().from(schema.newsPredictions);
    expect(rows[0].newsAgentMode).toBe('CATALYST_ONLY'); // real repo config default
  });
});
