import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB, real Express router via supertest) for two bugs
 * found this pass while reviewing the Add/Update Credentials form:
 * 1. POST /brokers was a blind INSERT with no unique constraint on brokerName - re-submitting
 *    credentials for the same broker silently created a second row, and
 *    BrokerManager.initialize()'s .find(b => b.brokerName === ...) would use whichever one query
 *    order returned first (typically the oldest) - a credential update could silently never apply.
 * 2. paperMode could be set directly from the raw request body, with no capability check and no
 *    LIVE_TRADING_CONFIRMATION_PHRASE - a connection could come up live on the next restart having
 *    never gone through the one gate this app treats as the sole thing standing between
 *    "configured" and "real capital at risk."
 *
 * Kept in its own file (not a second describe block in configRoutes.test.ts) deliberately: vitest
 * caches a dynamically-imported module per test FILE, not per describe block, so a second
 * beforeAll in the same file importing '../db' again would get back the first block's (by then
 * closed) connection rather than a fresh one pointed at a new ARGUS_DB_PATH.
 */
describe('configRoutes - POST /brokers upsert + paperMode isolation', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_configroutes_brokers_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');

    const { configRouter } = await import('./configRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v1/config', configRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('inserts a new connection defaulting to paperMode:true even when the client sends paperMode:false', async () => {
    const res = await request(app).post('/api/v1/config/brokers').send({
      brokerName: 'Test Broker A', apiKeyEncrypted: 'key-1', apiSecretEncrypted: 'secret-1', paperMode: false,
    });
    expect(res.status).toBe(200);

    const rows = await db.select().from(schema.brokerConnections).where(eq(schema.brokerConnections.brokerName, 'Test Broker A'));
    expect(rows).toHaveLength(1);
    expect(rows[0].paperMode).toBe(true);
  });

  it('updates the existing row instead of creating a duplicate when the same broker is submitted again', async () => {
    await request(app).post('/api/v1/config/brokers').send({ brokerName: 'Test Broker B', apiKeyEncrypted: 'v1' });
    const res = await request(app).post('/api/v1/config/brokers').send({ brokerName: 'Test Broker B', apiKeyEncrypted: 'v2' });
    expect(res.status).toBe(200);

    const rows = await db.select().from(schema.brokerConnections).where(eq(schema.brokerConnections.brokerName, 'Test Broker B'));
    expect(rows).toHaveLength(1); // not 2 - the real bug this closes
    const { EncryptionService } = await import('../core/EncryptionService');
    expect(EncryptionService.decrypt(rows[0].apiKeyEncrypted)).toBe('v2'); // the update actually took effect
  });

  it('updating credentials on an already-live connection does not silently flip it back to paper', async () => {
    await request(app).post('/api/v1/config/brokers').send({ brokerName: 'Test Broker C', apiKeyEncrypted: 'v1' });
    await db.update(schema.brokerConnections).set({ paperMode: false }).where(eq(schema.brokerConnections.brokerName, 'Test Broker C'));

    const res = await request(app).post('/api/v1/config/brokers').send({ brokerName: 'Test Broker C', apiKeyEncrypted: 'rotated-key' });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.brokerConnections).where(eq(schema.brokerConnections.brokerName, 'Test Broker C'));
    expect(row.paperMode).toBe(false); // unchanged by the credentials update
    const { EncryptionService } = await import('../core/EncryptionService');
    expect(EncryptionService.decrypt(row.apiKeyEncrypted)).toBe('rotated-key');
  });
});
