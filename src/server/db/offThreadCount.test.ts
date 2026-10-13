import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { sql } from 'drizzle-orm';

describe('countOffThread', () => {
  let tmp: string; let db: any; let sqliteDb: any; let schema: any; let countOffThread: any; let stop: any;
  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_offthread_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    ({ db, sqliteDb } = await import('./index'));
    schema = await import('./schema');
    ({ countOffThread, stopOffThreadCountWorker: stop } = await import('./offThreadCount'));
  });
  afterAll(() => {
    stop?.();
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns the same exact count as the main-thread query, computed on the worker', async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 25; i++) {
      await db.insert(schema.trades).values({ id: 'ot-' + i, symbol: 'AAPL', side: 'BUY', quantity: 1, price: 1, status: 'FILLED', timestamp: now, traceId: 'ot-trace-' + i });
    }
    const builder = db.select({ count: sql<number>`count(*)` }).from(schema.trades);
    const main = (await builder)[0].count;
    const off = await countOffThread(db.select({ count: sql<number>`count(*)` }).from(schema.trades));
    expect(off).toBe(main);
    expect(off).toBe(25);
  });

  it('refuses anything that is not a count(*) select (read-only, single purpose)', async () => {
    const r = await countOffThread({ toSQL: () => ({ sql: 'delete from trades', params: [] }) });
    expect(r).toBeNull();
  });

  it('resolves null (never throws) when the statement errors', async () => {
    const r = await countOffThread({ toSQL: () => ({ sql: 'select count(*) from no_such_table', params: [] }) });
    expect(r).toBeNull();
  });
});
