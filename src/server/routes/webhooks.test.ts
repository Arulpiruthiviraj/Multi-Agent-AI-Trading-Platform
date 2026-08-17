import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { webhooksRouter } from './webhooks';

describe('webhooksRouter - SSRF guard on write/test routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/webhooks', webhooksRouter);

  it('rejects creating a webhook pointed at a private/internal address', async () => {
    const res = await request(app).post('/api/v1/webhooks').send({
      name: 'evil', url: 'http://169.254.169.254/latest/meta-data/', type: 'generic',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unsafe webhook URL');
  });

  it('rejects updating a webhook to a private/internal address', async () => {
    const created = await request(app).post('/api/v1/webhooks').send({
      name: 'real', url: 'https://hooks.slack.com/services/T00/B00/REAL', type: 'slack',
    });
    expect(created.status).toBe(200);
    const res = await request(app).put(`/api/v1/webhooks/${created.body.id}`).send({ url: 'http://127.0.0.1:6379/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unsafe webhook URL');
  });

  it('rejects testing a private/internal address', async () => {
    const res = await request(app).post('/api/v1/webhooks/test').send({ url: 'http://10.0.0.1/', type: 'generic' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unsafe webhook URL');
  });
});
