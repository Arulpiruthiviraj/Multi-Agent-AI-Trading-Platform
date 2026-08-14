import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router mounted via supertest) for
 * hardening-pass Phase 9: GET /api/v2/system/events's new `since` param. Previously this route
 * only ever returned the in-memory recentEvents ring buffer - a client reconnecting after any gap
 * (network blip, tab backgrounded) had no way to ask "what did I miss," and lost those events
 * from the frontend's perspective forever. `since` queries the durable event_traces table
 * (written by EventStore.ts for every decision-lifecycle event) instead, real proof that a client
 * can recover a real gap. The no-param path is asserted to be byte-for-byte unchanged.
 */
describe('GET /api/v2/system/events - reconnect backfill (Phase 9 hardening)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let recentEvents: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2eventsbackfill_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ recentEvents } = await import('../core/EventStore'));

    const { v2Router } = await import('./v2System');
    app = express();
    app.use(express.json());
    app.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('with no `since` param, returns the in-memory recentEvents ring buffer unchanged (existing behavior preserved)', async () => {
    recentEvents.unshift({ eventId: 'mem-1', schemaVersion: 1, correlationId: null, source: 'test', type: 'TEST_EVENT', timestamp: Date.now(), payload: { hello: 'world' } });

    const res = await request(app).get('/api/v2/system/events');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.backfill).toBeUndefined();
    expect(res.body.events.some((e: any) => e.eventId === 'mem-1')).toBe(true);
  });

  it('with `since`, returns only real durable event_traces rows strictly after that timestamp', async () => {
    const base = Date.parse('2026-01-15T12:00:00.000Z');
    await db.insert(schema.eventTraces).values([
      { id: 'evt-old', correlationId: 'c-old', timestamp: base - 5000, source: 'TestAgent', eventType: 'TRADE_IDEA_GENERATED', payload: JSON.stringify({ symbol: 'AAPL' }) },
      { id: 'evt-new-1', correlationId: 'c-new-1', timestamp: base + 1000, source: 'TestAgent', eventType: 'TRADE_IDEA_GENERATED', payload: JSON.stringify({ symbol: 'MSFT' }) },
      { id: 'evt-new-2', correlationId: 'c-new-2', timestamp: base + 2000, source: 'TestAgent', eventType: 'ORDER_EXECUTED', payload: JSON.stringify({ symbol: 'MSFT', status: 'FILLED' }) },
    ]);

    const res = await request(app).get(`/api/v2/system/events?since=${base}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.backfill).toBe(true);
    const ids = res.body.events.map((e: any) => e.eventId);
    expect(ids).not.toContain('evt-old'); // strictly before `since` - correctly excluded
    expect(ids).toContain('evt-new-1');
    expect(ids).toContain('evt-new-2');
  });

  it('returns real events in ascending timestamp order, oldest-missed-first', async () => {
    const base = Date.parse('2026-02-01T00:00:00.000Z');
    await db.insert(schema.eventTraces).values([
      { id: 'ord-3', timestamp: base + 300, source: 'A', eventType: 'ORDER_EXECUTED', payload: null },
      { id: 'ord-1', timestamp: base + 100, source: 'A', eventType: 'ORDER_EXECUTED', payload: null },
      { id: 'ord-2', timestamp: base + 200, source: 'A', eventType: 'ORDER_EXECUTED', payload: null },
    ]);

    const res = await request(app).get(`/api/v2/system/events?since=${base}`);

    const ids = res.body.events.filter((e: any) => e.eventId.startsWith('ord-')).map((e: any) => e.eventId);
    expect(ids).toEqual(['ord-1', 'ord-2', 'ord-3']);
  });

  it('deserializes the persisted JSON payload back into a real object, not a raw string', async () => {
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    await db.insert(schema.eventTraces).values([
      { id: 'payload-test', timestamp: base + 1, source: 'A', eventType: 'ORDER_EXECUTED', payload: JSON.stringify({ symbol: 'TSLA', status: 'FILLED' }) },
    ]);

    const res = await request(app).get(`/api/v2/system/events?since=${base}`);

    const evt = res.body.events.find((e: any) => e.eventId === 'payload-test');
    expect(evt.payload).toEqual({ symbol: 'TSLA', status: 'FILLED' });
  });

  it('ignores a non-numeric `since` value rather than throwing, falling back to the in-memory buffer', async () => {
    const res = await request(app).get('/api/v2/system/events?since=not-a-number');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.backfill).toBeUndefined();
  });
});
