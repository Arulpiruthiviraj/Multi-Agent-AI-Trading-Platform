import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { operatorReportGuard, OPERATOR_REPORT_PATHS, UI_POLLED_REPORT_PATHS } from './operatorReportGuard';
import { resetHeavyReportGuardForTests, setRssReaderForTests } from './heavyReportGuard';

afterEach(() => resetHeavyReportGuardForTests());

describe('operatorReportGuard (REGRESSION 2026-10-14: an operator report burst froze the engine)', () => {
  const makeApp = (handlerMs: number) => {
    const app = express();
    app.use(['/slow'], operatorReportGuard);
    app.get('/slow', (_req, res) => { setTimeout(() => res.json({ ok: true }), handlerMs); });
    return app;
  };

  it('serializes: while one operator report is in flight a second is refused with 429, and a later one succeeds', async () => {
    const app = makeApp(150);
    const first = request(app).get('/slow').then((r) => r);
    await new Promise((r) => setTimeout(r, 40));
    const second = await request(app).get('/slow');
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('CONCURRENT_HEAVY_REPORT');
    expect((await first).status).toBe(200);
    expect((await request(app).get('/slow')).status).toBe(200); // slot released after the response finished
  });

  it('refuses to start while process memory is already elevated (memory breaker shared with guardHeavyReport)', async () => {
    setRssReaderForTests(() => 10_000_000);
    const res = await request(makeApp(5)).get('/slow');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('MEMORY_ELEVATED');
  });
});

describe('observability route inventory (REGRESSION 2026-10-14: 35 report routes were unguarded)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../routes/observabilityRoutes.ts'), 'utf8');
  const re = /observabilityRouter\.(get|post)\(\s*'([^']+)'/g;
  const starts: Array<{ i: number; route: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) starts.push({ i: m.index, route: m[2] });
  const firstSegment = (p: string) => '/' + p.split('/').filter(Boolean)[0];

  it('every route that runs a report builder is individually guarded, behind operatorReportGuard, or explicitly UI-polled', () => {
    expect(starts.length).toBeGreaterThan(30);
    const operator = new Set(OPERATOR_REPORT_PATHS); const ui = new Set(UI_POLLED_REPORT_PATHS);
    const unprotected: string[] = [];
    starts.forEach((s, k) => {
      const block = src.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : src.length);
      const runsBuilder = /\b(build\w+|fetch\w+Report)\(/.test(block);
      if (!runsBuilder) return;
      const seg = firstSegment(s.route);
      if (/guardHeavyReport\(/.test(block) || operator.has(seg) || ui.has(seg)) return;
      unprotected.push(s.route);
    });
    expect(unprotected).toEqual([]);
  });

  it('the router mounts operatorReportGuard on exactly the declared operator paths (and individually guarded routes are not double-wrapped)', () => {
    expect(src).toMatch(/observabilityRouter\.use\(\[\.\.\.OPERATOR_REPORT_PATHS\], operatorReportGuard\)/);
    for (const p of OPERATOR_REPORT_PATHS) {
      const idx = starts.findIndex((s) => firstSegment(s.route) === p);
      expect(idx, `${p} must be a real route`).toBeGreaterThanOrEqual(0);
      const block = src.slice(starts[idx].i, idx + 1 < starts.length ? starts[idx + 1].i : src.length);
      expect(/guardHeavyReport\(/.test(block), `${p} would deadlock against its own outer guard`).toBe(false);
    }
  });
});
