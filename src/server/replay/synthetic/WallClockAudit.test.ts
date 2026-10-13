import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateWallClockAudit, startWallClockAudit } from './WallClockAudit';
import { loadRepoConfigJson } from '../../config/loadRepoConfigJson';

describe('WallClockAudit', () => {
  it('attributes Date.now() calls to their caller and restores the native clock', () => {
    const prev = process.env.SYNTHETIC_SIMULATION;
    process.env.SYNTHETIC_SIMULATION = 'true';
    const nativeBefore = Date.now;
    try {
      const h = startWallClockAudit();
      function marketTimeDecision() { return Date.now(); }
      marketTimeDecision(); marketTimeDecision();
      const callers = h.stop();
      expect(Date.now).toBe(nativeBefore);
      const hit = callers.find((c) => c.fn.includes('marketTimeDecision'));
      expect(hit?.calls).toBe(2);
      expect(hit?.file).toMatch(/WallClockAudit\.test\.ts$/);
    } finally {
      if (prev === undefined) delete process.env.SYNTHETIC_SIMULATION; else process.env.SYNTHETIC_SIMULATION = prev;
    }
  });

  it('refuses to wrap the clock outside a SYNTHETIC_SIMULATION process', () => {
    const prev = process.env.SYNTHETIC_SIMULATION;
    delete process.env.SYNTHETIC_SIMULATION;
    try { expect(() => startWallClockAudit()).toThrow(/SYNTHETIC_SIMULATION/); } finally { if (prev !== undefined) process.env.SYNTHETIC_SIMULATION = prev; }
  });

  it('an unclassified decision-module caller is unexplained; non-decision callers are ignored', () => {
    const r = evaluateWallClockAudit(
      [
        { file: 'src/server/services/PortfolioMonitor.ts', fn: 'review', calls: 5 },
        { file: 'src/server/services/PortfolioMonitor.ts', fn: 'timedWorkCycle', calls: 2 },
        { file: 'src/server/util/logger.ts', fn: 'log', calls: 99 },
      ],
      /src\/server\/services\/PortfolioMonitor\.ts/,
      [{ filePattern: 'PortfolioMonitor[.]ts[|]timedWorkCycle', classification: 'LATENCY_ONLY', reason: 'duration measurement' }],
    );
    expect(r.unexplained.map((c) => c.fn)).toEqual(['review']);
    expect(r.explained.map((c) => c.fn)).toEqual(['timedWorkCycle']);
    expect(r.ignored).toBe(99);
  });
});

describe('wall-clock ratchet in trading-decision modules', () => {
  const baseline = loadRepoConfigJson<{ files: Record<string, { dateNow: number; newDate: number }> }>('syntheticWallClockBaseline.json');
  const repoRoot = path.resolve(__dirname, '../../../..');
  for (const [file, allowed] of Object.entries(baseline.files)) {
    it(`${file} does not add wall-clock reads (Date.now <= ${allowed.dateNow}, new Date() <= ${allowed.newDate})`, () => {
      const src = readFileSync(path.join(repoRoot, file), 'utf8');
      const dateNow = (src.match(/Date\.now\(\)/g) ?? []).length;
      const newDate = (src.match(/new Date\(\)/g) ?? []).length;
      expect(dateNow, `${file}: new Date.now() read added - use the simulation/replay clock seam or raise the reviewed baseline deliberately`).toBeLessThanOrEqual(allowed.dateNow);
      expect(newDate, `${file}: new zero-arg new Date() added - same rule`).toBeLessThanOrEqual(allowed.newDate);
    });
  }
});
