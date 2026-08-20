import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { runtimeRouter } from './v2Runtime';

describe('v2Runtime routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v2/runtime', runtimeRouter);
  });

  it('GET /runtime/status is registered', async () => {
    const res = await request(app).get('/api/v2/runtime/status');
    expect(res.status).toBeLessThan(500);
    expect(res.body).toHaveProperty('runtime');
  });

  it('GET /runtime/health is registered', async () => {
    const res = await request(app).get('/api/v2/runtime/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('health');
  });
});
