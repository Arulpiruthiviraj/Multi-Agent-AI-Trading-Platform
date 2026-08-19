import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real bug found and fixed this pass: EventStore.trackEvent() used to store/persist the raw
 * EventBus payload completely unredacted. queryTraces.ts's getDecisionTrace() redacts on its own
 * read path, but GET /api/v1/system/event-traces, GET /api/v2/system/events, and
 * GET /api/v2/system/trace/:traceId (plus their in-memory fallbacks, recentEvents/tradeTraces)
 * all read this same data and served it verbatim - any secret that ever landed in an EventBus
 * payload was persisted in cleartext and served to any caller of those endpoints.
 */
describe('EventStore redacts secrets at write time', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: any;
  let schema: any;
  let eventBus: any;
  let recentEvents: any[];
  let tradeTraces: Record<string, any[]>;
  let EVENTS: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_eventstore_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('./EventBus'));
    ({ EVENTS } = await import('./eventNames'));
    ({ recentEvents, tradeTraces } = await import('./EventStore'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('redacts a secret-shaped field in the in-memory recentEvents ring buffer', () => {
    const traceId = `evtstore-test-${Date.now()}`;
    eventBus.emit(EVENTS.RISK_ASSESSMENT_STARTED, {
      traceId,
      symbol: 'AAPL',
      side: 'BUY',
      confidence: 0.9,
      agent: 'TechnicalAgent',
      reasoning: 'test',
      apiSecret: 'should-not-leak-1234567',
    });

    const envelope = recentEvents.find((e) => e.correlationId === traceId);
    expect(envelope).toBeDefined();
    expect(envelope.payload.apiSecret).toBe('[REDACTED]');
    expect(envelope.payload.symbol).toBe('AAPL');

    const traceRows = tradeTraces[traceId];
    expect(traceRows?.[0]?.payload?.apiSecret).toBe('[REDACTED]');
  });

  it('redacts the same secret-shaped field in the persisted event_traces row', async () => {
    const traceId = `evtstore-test-db-${Date.now()}`;
    eventBus.emit(EVENTS.RISK_ASSESSMENT_STARTED, {
      traceId,
      symbol: 'NVDA',
      side: 'SELL',
      confidence: 0.8,
      agent: 'TechnicalAgent',
      reasoning: 'test',
      secretKey: 'should-not-leak-db-9876543',
    });

    // DB write is fire-and-forget inside trackEvent() - give its microtask a turn to land.
    await new Promise((r) => setTimeout(r, 50));

    const row = (await db.select().from(schema.eventTraces)).find((r: any) => r.correlationId === traceId);
    expect(row).toBeDefined();
    const payload = JSON.parse(row.payload);
    expect(payload.secretKey).toBe('[REDACTED]');
    expect(payload.symbol).toBe('NVDA');
  });
});
