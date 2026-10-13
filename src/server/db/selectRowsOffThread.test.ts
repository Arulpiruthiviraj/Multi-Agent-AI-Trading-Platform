import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getTableColumns, asc, gt } from 'drizzle-orm';

/**
 * 2026-10-13: the evaluators' pending-page SELECTs moved to the read-only worker thread because single synchronous
 * main-thread statements were taking 34-48 s on the production DB. The move is only acceptable if it returns EXACTLY the rows
 * (same values, same driver decoding) the main-thread query returned, and if it never blocks the event loop.
 */
describe('selectRowsOffThread', () => {
  let tmp: string; let db: any; let sqliteDb: any; let schema: any; let selectRowsOffThread: any; let stop: any;
  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_offthread_rows_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    ({ db, sqliteDb } = await import('./index'));
    schema = await import('./schema');
    ({ selectRowsOffThread, stopOffThreadCountWorker: stop } = await import('./offThreadCount'));
    for (let i = 0; i < 40; i++) {
      await db.insert(schema.agentPredictions).values({
        id: `p${String(i).padStart(3, '0')}`, agentName: i % 2 ? 'TechnicalAgent' : 'QuantEngine', symbol: `S${i % 5}`,
        prediction: i % 3 ? 'BUY' : 'SELL', confidence: 0.5 + i / 100, reasoning: `r${i}`,
        timestamp: new Date(1_790_000_000_000 + i * 60_000).toISOString(), traceId: i % 7 === 0 ? null : `t${i}`,
      });
    }
  });
  afterAll(() => {
    try { stop(); } catch { /* ignore */ }
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });

  const build = (after: string) => {
    const cols = getTableColumns(schema.agentPredictions);
    return { cols, q: db.select(cols).from(schema.agentPredictions).where(gt(schema.agentPredictions.timestamp, after)).orderBy(asc(schema.agentPredictions.timestamp)).limit(25) };
  };

  it('returns exactly the rows (values, nulls, types) the main-thread drizzle query returns', async () => {
    const after = new Date(1_790_000_000_000 + 5 * 60_000).toISOString();
    const { cols, q } = build(after);
    const mainThread = await q;
    const off = await selectRowsOffThread(build(after).q, cols);
    expect(off).not.toBeNull();
    expect(off).toHaveLength(25);
    expect(off).toEqual(mainThread);
  });

  it('does not block the event loop while the worker runs a slow query (the same statement on the main thread does)', async () => {
    const slow = { toSQL: () => ({ sql: 'select (select count(*) from (with recursive c(x) as (select 1 union all select x+1 from c where x < 6000000) select x from c)) as n', params: [] }) };
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    const t0 = Date.now();
    const rows = await selectRowsOffThread(slow, { n: {} });
    const elapsed = Date.now() - t0;
    clearInterval(timer);
    expect(rows).toEqual([{ n: 6000000 }]);
    expect(elapsed).toBeGreaterThan(100); // genuinely slow, so the assertion below is meaningful
    expect(ticks).toBeGreaterThan(10); // the event loop kept ticking throughout

    // control: the identical statement on the main thread blocks the loop for its whole duration
    let mainTicks = 0;
    const timer2 = setInterval(() => { mainTicks++; }, 5);
    sqliteDb.prepare(slow.toSQL().sql).get();
    await new Promise((r) => setTimeout(r, 0));
    clearInterval(timer2);
    expect(mainTicks).toBeLessThanOrEqual(2);
  });

  it('refuses non-SELECT SQL and resolves null on a bad query (callers skip the cycle, never fall back to the main thread)', async () => {
    expect(await selectRowsOffThread({ toSQL: () => ({ sql: 'delete from agent_predictions', params: [] }) }, {})).toBeNull();
    expect(await selectRowsOffThread({ toSQL: () => ({ sql: 'select * from no_such_table', params: [] }) }, { a: {} }, 5000)).toBeNull();
    expect(sqliteDb.prepare('select count(*) c from agent_predictions').get().c).toBe(40); // nothing was deleted
  });
});
