/**
 * END-TO-END integration test for Jev shadow scoring (2026-10-15 accountability fix).
 *
 * What is REAL here: the event consumer (kickOffJevShadowScoring), AICallGovernor, JevProvider's HTTP client, schema validation, the SQLite ledger
 * (a throwaway file via ARGUS_DB_PATH with real migrations) and getCalibrationSummary. What is STAND-IN: only the remote Jev server (a local HTTP
 * server speaking the documented POST /v1/systemone wire format). A real authenticated call against api.typesafe.ai is recorded in
 * docs/audits/ARGUS_JEV_INTEGRATION_FAILURE_ROOT_CAUSE.md (scripts/forensic/jevE2eProof.ts); this test is the permanent regression guard and does not
 * replace it. Earlier tests (JevShadowLedger.test.ts) explicitly skipped DB round-trips, which is how an idle integration passed review.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const KEY = 'test-key-not-a-secret';
let server: http.Server;
let hits: Array<{ auth: string | undefined; body: any }> = [];
let mode: 'ok' | 'http500' | 'garbage' = 'ok';
let tmpDir: string;
let kickOff: typeof import('./JevNewsTriage')['kickOffJevShadowScoring'];
let status: typeof import('./JevNewsTriage')['getJevShadowStatus'];
let summary: typeof import('./JevShadowLedger')['getCalibrationSummary'];
let countRows: () => Promise<number>;

function answerFor(q: any): any {
  if (q.type === 'noul') return { type: 'noul', noul: 0.7 };
  if (q.type === 'choice') { const first = Object.keys(q.criteria)[0]; return { type: 'choice', choice: first, probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, 1 / Object.keys(q.criteria).length])), confidence: 0.6 }; }
  return { type: 'score', score: 2, legend: {}, probabilities: Object.fromEntries(q.criteria.map((_: string, i: number) => [String(i), 1 / q.criteria.length])), confidence: 0.55 };
}

function article(over: Record<string, unknown> = {}) {
  const fp = 'fp-' + Math.random().toString(36).slice(2);
  return {
    id: fp, title: 'Acme Corp announces definitive merger agreement', content: 'Acme Corp said on Thursday it has signed a definitive agreement to be acquired in an all-cash transaction valued at a premium to the prior close.',
    url: 'https://example.test/a', source: 'TestWire', author: 'x', publishedAt: new Date().toISOString(), symbols: ['ACME'], fingerprint: fp, ...over,
  } as any;
}
const ctx = { category: 'M&A', credibility: 0.9, isNewCluster: true, priorArticleCount: 0, impactScore01: 0.6, timeHorizon: 'Intraday' };
const waitFor = async (pred: () => Promise<boolean>, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = null; try { body = JSON.parse(raw); } catch { /* ignore */ }
      hits.push({ auth: req.headers.authorization, body });
      if (mode === 'http500') { res.statusCode = 500; res.end('boom'); return; }
      if (mode === 'garbage') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ answers: { wrong: { type: 'noul', noul: 5 } } })); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'jev-test-1', answers: Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, answerFor(q)])), usage: { input_tokens: 321 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-e2e-'));
  process.env.ARGUS_DB_PATH = path.join(tmpDir, 'iso.db');
  process.env.JEV_API_KEY = KEY;
  process.env.JEV_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = 'true';
  const triage = await import('./JevNewsTriage');
  kickOff = triage.kickOffJevShadowScoring; status = triage.getJevShadowStatus;
  summary = (await import('./JevShadowLedger')).getCalibrationSummary;
  const { db } = await import('../db');
  const { sql } = await import('drizzle-orm');
  countRows = async () => Number(((await db.all(sql`select count(*) c from jev_shadow_scores`)) as any[])[0].c);
}, 60_000);

afterAll(async () => { await new Promise((r) => server.close(r)); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* sqlite handle may linger on Windows */ } });
beforeEach(() => { hits = []; mode = 'ok'; });

describe('Jev shadow scoring: real consumer -> governor -> provider -> ledger -> report', () => {
  it('an eligible article is sent (authenticated), validated, persisted, and shows in the calibration report', async () => {
    const before = await countRows();
    kickOff({ article: article(), symbol: 'ACME', traceId: 't-ok', llmAnalysis: null, deterministic: ctx });
    expect(await waitFor(async () => (await countRows()) === before + 1)).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0].auth).toBe(`Bearer ${KEY}`);
    expect(Object.keys(hits[0].body.questions).length).toBeGreaterThan(0);
    const s = await summary();
    expect(s.totalScored).toBe(before + 1);
    expect(s.totalJevInputTokens).toBeGreaterThan(0);
    expect(s.avgJevLatencyMs).not.toBeNull();
  });

  it('the same (article, symbol) observation is recorded once, not twice (regression: cache hit used to double-count rows, tokens and cost)', async () => {
    const a = article();
    const before = await countRows();
    kickOff({ article: a, symbol: 'DUPA', traceId: 't-d1', llmAnalysis: null, deterministic: ctx });
    expect(await waitFor(async () => (await countRows()) === before + 1)).toBe(true);
    kickOff({ article: a, symbol: 'DUPA', traceId: 't-d2', llmAnalysis: null, deterministic: ctx });
    await new Promise((r) => setTimeout(r, 600));
    expect(await countRows()).toBe(before + 1);
    // the same article for a DIFFERENT symbol is a different observation
    kickOff({ article: a, symbol: 'DUPB', traceId: 't-d3', llmAnalysis: null, deterministic: ctx });
    expect(await waitFor(async () => (await countRows()) === before + 2)).toBe(true);
  });

  it('no usable input -> no request and no row', async () => {
    const before = await countRows();
    kickOff({ article: article({ content: '' }), symbol: 'EMPT', traceId: 't-empty', llmAnalysis: null, deterministic: ctx });
    kickOff({ article: article(), symbol: 'not a ticker!!', traceId: 't-sym', llmAnalysis: null, deterministic: ctx });
    await new Promise((r) => setTimeout(r, 500));
    expect(hits).toHaveLength(0);
    expect(await countRows()).toBe(before);
  });

  it('provider HTTP 500 and a malformed response are non-blocking and write nothing', async () => {
    const before = await countRows();
    for (const m of ['http500', 'garbage'] as const) {
      mode = m;
      const t0 = Date.now();
      expect(() => kickOff({ article: article(), symbol: m === 'http500' ? 'ERRA' : 'ERRB', traceId: 't-' + m, llmAnalysis: null, deterministic: ctx })).not.toThrow();
      expect(Date.now() - t0).toBeLessThan(250); // fire-and-forget: the caller is never held
    }
    await new Promise((r) => setTimeout(r, 1500));
    expect(await countRows()).toBe(before);
  });

  it('a configured key with the shadow flag unset is reported as IDLE with the reason, and sends nothing (the 2026-10-15 production state)', async () => {
    const prev = process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
    delete process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED;
    try {
      const st = status();
      expect(st.keyConfigured).toBe(true);
      expect(st.active).toBe(false);
      expect(st.idleReason).toContain('ARGUS_JEV_SHADOW_SCORING_ENABLED');
      const before = await countRows();
      kickOff({ article: article(), symbol: 'OFFX', traceId: 't-off', llmAnalysis: null, deterministic: ctx });
      await new Promise((r) => setTimeout(r, 400));
      expect(hits).toHaveLength(0);
      expect(await countRows()).toBe(before);
    } finally {
      process.env.ARGUS_JEV_SHADOW_SCORING_ENABLED = prev;
    }
    expect(status().active).toBe(true);
  });

  it('a complete Jev outage (server down) never blocks or throws in the caller', async () => {
    const saved = process.env.JEV_BASE_URL;
    await new Promise((r) => server.close(r));
    try {
      const t0 = Date.now();
      expect(() => kickOff({ article: article(), symbol: 'DOWN', traceId: 't-down', llmAnalysis: null, deterministic: ctx })).not.toThrow();
      expect(Date.now() - t0).toBeLessThan(250);
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      await new Promise<void>((r) => server.listen(Number(new URL(saved as string).port), '127.0.0.1', () => r()));
    }
  });
});
