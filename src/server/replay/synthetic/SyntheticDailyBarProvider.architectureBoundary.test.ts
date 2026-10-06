/**
 * Architecture-boundary proof for SyntheticDailyBarProvider.ts, same pattern as
 * src/server/architecture.protection.test.ts: a static grep-based check that no file outside
 * src/server/replay/synthetic/ ever imports this module, plus a runtime proof that the module
 * itself refuses to run outside a synthetic simulation session even if that boundary were ever
 * violated. Both checks matter: the static check stops it from being wired into a live/paper path
 * at all; the runtime guard is the fail-closed backstop if it ever were.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('Architecture protection: SyntheticDailyBarProvider stays inside the synthetic harness', () => {
  it('no file outside src/server/replay/synthetic/ imports SyntheticDailyBarProvider', () => {
    const srcRoot = join(ROOT, 'src');
    const files = listTsFiles(srcRoot);
    const hits: string[] = [];
    for (const f of files) {
      const path = relative(ROOT, f).replace(/\\/g, '/');
      if (path.startsWith('src/server/replay/synthetic/')) continue; // the harness itself - allowed
      if (path === 'src/server/replay/synthetic/SyntheticDailyBarProvider.ts') continue;
      const text = readFileSync(f, 'utf8');
      if (/from ['"][^'"]*SyntheticDailyBarProvider['"]/.test(text)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });

  it('scripts/ (CLI launchers) never import SyntheticDailyBarProvider directly', () => {
    const scriptsRoot = join(ROOT, 'scripts');
    const files = listTsFiles(scriptsRoot);
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/from ['"][^'"]*SyntheticDailyBarProvider['"]/.test(text)) hits.push(relative(ROOT, f));
    }
    expect(hits).toEqual([]);
  });
});

describe('Runtime proof: SyntheticDailyBarProvider fails closed outside SYNTHETIC_SIMULATION=true', () => {
  const original = process.env.SYNTHETIC_SIMULATION;

  afterEach(() => {
    if (original === undefined) delete process.env.SYNTHETIC_SIMULATION;
    else process.env.SYNTHETIC_SIMULATION = original;
  });

  it('generateSyntheticPriorDayHistory throws when SYNTHETIC_SIMULATION is not "true"', async () => {
    delete process.env.SYNTHETIC_SIMULATION;
    const { generateSyntheticPriorDayHistory } = await import('./SyntheticDailyBarProvider');
    const { getScenario } = await import('./SyntheticScenario');
    const config = { symbol: 'TEST', startPrice: 100, baseVolatility: 0.0006, baseVolumePerBar: 1000, baseSpreadPct: 0.0001 };
    expect(() => generateSyntheticPriorDayHistory(config, getScenario('QUIET_OPEN'), 1, Date.now())).toThrow(
      /SYNTHETIC_SIMULATION/,
    );
  });

  it('rollupTodaysDailyBar throws when SYNTHETIC_SIMULATION is not "true"', async () => {
    delete process.env.SYNTHETIC_SIMULATION;
    const { rollupTodaysDailyBar } = await import('./SyntheticDailyBarProvider');
    expect(() => rollupTodaysDailyBar([], Date.now())).toThrow(/SYNTHETIC_SIMULATION/);
  });

  it('generateSyntheticPriorDayHistory succeeds when SYNTHETIC_SIMULATION=true', async () => {
    process.env.SYNTHETIC_SIMULATION = 'true';
    const { generateSyntheticPriorDayHistory, PRIOR_TRADING_DAYS } = await import('./SyntheticDailyBarProvider');
    const { getScenario } = await import('./SyntheticScenario');
    const config = { symbol: 'TEST', startPrice: 100, baseVolatility: 0.0006, baseVolumePerBar: 1000, baseSpreadPct: 0.0001 };
    const bars = generateSyntheticPriorDayHistory(config, getScenario('QUIET_OPEN'), 1, Date.now());
    expect(bars.length).toBe(PRIOR_TRADING_DAYS);
    // Chronological order, most recent (closest to session start) last.
    expect(bars[bars.length - 1].close).toBeCloseTo(100, 2);
    for (let i = 1; i < bars.length; i++) expect(bars[i].timestamp).toBeGreaterThan(bars[i - 1].timestamp);
  });

  it('same seed produces byte-identical prior-day history (determinism)', async () => {
    process.env.SYNTHETIC_SIMULATION = 'true';
    const { generateSyntheticPriorDayHistory } = await import('./SyntheticDailyBarProvider');
    const { getScenario } = await import('./SyntheticScenario');
    const config = { symbol: 'TEST', startPrice: 100, baseVolatility: 0.0006, baseVolumePerBar: 1000, baseSpreadPct: 0.0001 };
    const fixedSessionStartMs = new Date('2026-09-15T13:30:00.000Z').getTime();
    const a = generateSyntheticPriorDayHistory(config, getScenario('TRENDING_BULL_GAP_AND_GO'), 20261006, fixedSessionStartMs);
    const b = generateSyntheticPriorDayHistory(config, getScenario('TRENDING_BULL_GAP_AND_GO'), 20261006, fixedSessionStartMs);
    expect(a).toEqual(b);
  });

  it('a bull-dominant scenario produces net-positive drift over the prior history; a bear-dominant scenario produces net-negative drift', async () => {
    process.env.SYNTHETIC_SIMULATION = 'true';
    const { generateSyntheticPriorDayHistory } = await import('./SyntheticDailyBarProvider');
    const { getScenario } = await import('./SyntheticScenario');
    const config = { symbol: 'TEST', startPrice: 100, baseVolatility: 0.0006, baseVolumePerBar: 1000, baseSpreadPct: 0.0001 };
    const bull = generateSyntheticPriorDayHistory(config, getScenario('TRENDING_BULL_GAP_AND_GO'), 1, Date.now());
    const bear = generateSyntheticPriorDayHistory(config, getScenario('TRENDING_BEAR'), 1, Date.now());
    expect(bull[0].close).toBeLessThan(bull[bull.length - 1].close); // oldest close < most recent close
    expect(bear[0].close).toBeGreaterThan(bear[bear.length - 1].close);
  });
});
