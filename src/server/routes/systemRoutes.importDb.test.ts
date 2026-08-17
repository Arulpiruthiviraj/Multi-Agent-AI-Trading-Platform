import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB) for a bug found this pass: POST
 * /api/v1/system/import-db used to write the raw request body straight over the live DB file with
 * no format check and no backup - a malformed/wrong upload permanently destroyed the database with
 * no recovery path. Now validates the real SQLite file-header magic bytes and backs up the current
 * file before writing.
 */
describe('POST /system/import-db - format validation and backup-before-overwrite', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_importdb_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../db'));
    const { systemRouter } = await import('./systemRoutes');
    app = express();
    app.use('/api/v1', systemRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const f of fs.readdirSync(path.dirname(tmpDbPath))) {
      if (f.startsWith(path.basename(tmpDbPath))) {
        try { fs.unlinkSync(path.join(path.dirname(tmpDbPath), f)); } catch { /* best-effort cleanup */ }
      }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('rejects a non-SQLite upload with 400 and never touches the live database file', async () => {
    const before = fs.readFileSync(tmpDbPath);
    const res = await request(app)
      .post('/api/v1/system/import-db')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('not a real sqlite file, just garbage bytes'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid SQLite database/i);
    const after = fs.readFileSync(tmpDbPath);
    expect(after.equals(before)).toBe(true); // untouched
  });

  it('accepts a real SQLite-header upload and backs up the previous database first', async () => {
    const filesBefore = fs.readdirSync(path.dirname(tmpDbPath)).filter((f) => f.startsWith(path.basename(tmpDbPath) + '.pre-import-'));
    expect(filesBefore.length).toBe(0);

    // A minimal buffer with a real SQLite magic header - enough for the format check; this route
    // never opens the file as a database, only writes it, so it doesn't need to be a fully valid
    // page-structured DB for this test's purpose.
    const fakeSqliteFile = Buffer.concat([Buffer.from('SQLite format 3\0', 'utf8'), Buffer.alloc(100)]);
    const res = await request(app)
      .post('/api/v1/system/import-db')
      .set('Content-Type', 'application/octet-stream')
      .send(fakeSqliteFile);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/backed up/i);

    const filesAfter = fs.readdirSync(path.dirname(tmpDbPath)).filter((f) => f.startsWith(path.basename(tmpDbPath) + '.pre-import-'));
    expect(filesAfter.length).toBe(1);

    const written = fs.readFileSync(tmpDbPath);
    expect(written.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\0');
  });
});
