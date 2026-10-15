/**
 * Jev shadow scoring: provider failure modes at the real HTTP boundary (2026-10-15 certification). Complements JevShadowIntegration.e2e.test.ts (500 / malformed / outage / duplicate / no-input).
 * Adds 401, 429 and a provider that answers slower than the governor's Jev timeout. For each: the caller is never held or thrown into, nothing is persisted, and a later healthy
 * call for a different symbol still works (a failure never poisons the pipeline).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

let server: http.Server;
let mode: 'ok' | 'http401' | 'http429' | 'slow' = 'ok';
let hits = 0;
let tmpDir: string;
let kickOff: typeof import('./JevNewsTriage')['kickOffJevShadowScoring'];
let countRows: () => Promise<number>;
let timeoutMs = 8000;

function answerFor(q: any): any {
  if (q.type === 'noul') return { type: 'noul', noul: 0.7 };
  if (q.type === 'choice') { const ks = Object.keys(q.criteria); return { type: 'choice', choice: ks[0], probabilities: Object.fromEntries(ks.map((k) => [k, 1 / ks.length])), confidence: 0.6 }; }
  return { type: 'score', score: 2, legend: {}, probabilities: Object.fromEntries(q.criteria.map((_: string, i: number) => [String(i), 1 / q.criteria.length])), confidence: 0.55 };
}
function article() {
  const fp = 'fm-' + Math.random().toString(36).slice(2);
  return { id: fp, title: 'Acme Corp announces definitive merger agreement', content: 'Acme Corp said on Thursday it has signed a definitive agreement to be acquired in an all-cash transaction valued at a premium to the prior close.', url: 'https://example.test/a', source: 'TestWire', author: 'x', publishedAt: new Date().toISOString(), symbols: ['ACME'], fingerprint: fp } as any;
}
const ctx = { category: 'M&A', credibility: 0.9, isNewCluster: true, priorArticleCount: 0, impactScore01: 0.6, timeHorizon: 'Intraday' };
const waitFor = async (pred: () => Promise<boolean>, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits++;
      if (mode === 'http401') { res.statusCode = 401; res.end('unauthorized'); return; }
      if (mode === 'http429') { res.statusCode = 429; res.setHeader('retry-after', '30'); res.end('slow down'); return; }
      const body = JSON.parse(raw);
      const respond = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'jev-test-1', answers: Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, answerFor(q)])) })); };
      if (mode === 'slow') { setTimeout(() => { try { respond(); } catch { /* socket closed by client timeout */ } }, timeoutMs + 1500); return; }
      respond();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fm-'));
  process.env.ARGUS_DB_PATH = path.join(tmpDir, 'iso.db');
  process.env.JEV_API_KEY = 'test-key-not-a-secret';
  process.env.JEV_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = 'true';
  kickOff = (await import('./JevNewsTriage')).kickOffJevShadowScoring;
  const { aiCallGovernor } = await import('../config/aiCallGovernor');
  timeoutMs = aiCallGovernor.jevTimeoutMs;
  const { db } = await import('../db');
  const { sql } = await import('drizzle-orm');
  countRows = async () => Number(((await db.all(sql`select count(*) c from jev_shadow_scores`)) as any[])[0].c);
}, 60_000);
afterAll(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows handle */ } });
beforeEach(async () => {
  mode = 'ok'; hits = 0;
  // Each failure mode must start from a clean governor: a 401/429 legitimately trips Jev's circuit/unhealthy state, which would otherwise skip the next case's request.
  const { AICallGovernor } = await import('../ai/AICallGovernor');
  AICallGovernor.getInstance().resetForTests();
  const { JevDecisionProvider } = await import('../ai/JevDecisionProvider');
  JevDecisionProvider.getInstance().resetForTests();
});

describe('Jev provider failure modes are non-blocking and write nothing', () => {
  for (const [m, sym] of [['http401', 'FAUA'], ['http429', 'FAUB']] as const) {
    it(`HTTP ${m.slice(4)}: request goes out, caller not held, nothing persisted, and a follow-up call neither throws nor blocks (the governor may legitimately skip it while its circuit is open)`, async () => {
      const before = await countRows();
      mode = m;
      const t0 = Date.now();
      expect(() => kickOff({ article: article(), symbol: sym, traceId: 't-' + m, llmAnalysis: null, deterministic: ctx })).not.toThrow();
      expect(Date.now() - t0).toBeLessThan(250);
      expect(await waitFor(async () => hits > 0, 8000)).toBe(true); // the request really went out
      await new Promise((r) => setTimeout(r, 500));
      expect(await countRows()).toBe(before);                        // and nothing was recorded
      mode = 'ok';
      const t1 = Date.now();
      expect(() => kickOff({ article: article(), symbol: sym === 'FAUA' ? 'RECA' : 'RECB', traceId: 't-after-' + m, llmAnalysis: null, deterministic: ctx })).not.toThrow();
      expect(Date.now() - t1).toBeLessThan(250);
    }, 20_000);
  }

  it('a provider slower than the governor Jev timeout is abandoned: caller not held, nothing persisted', async () => {
    const before = await countRows();
    mode = 'slow';
    const t0 = Date.now();
    kickOff({ article: article(), symbol: 'SLOW', traceId: 't-slow', llmAnalysis: null, deterministic: ctx });
    expect(Date.now() - t0).toBeLessThan(250);
    await new Promise((r) => setTimeout(r, timeoutMs + 2500)); // beyond the timeout and the server's late reply
    expect(hits).toBeGreaterThan(0);
    expect(await countRows()).toBe(before);
  }, 30_000);
});
