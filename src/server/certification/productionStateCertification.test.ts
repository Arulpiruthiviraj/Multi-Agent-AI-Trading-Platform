/**
 * PRODUCTION_STATE certification tests (Layer 3), 2026-10-09.
 *
 * === PRODUCTION_STATE / MECHANISM_E2E — read before extending ===
 *
 * What these tests prove: the certification MODULE correctly reports the real
 * production authorization state (read from the DB through the canonical
 * resolver), and the mandatory invariant (0 authorized => QUANT_FIRST is
 * operationally inactive => FAIL) cannot be weakened without these tests
 * failing.
 *
 * What these tests do NOT prove (standing testing principle): that tomorrow's
 * real Argus state can naturally reach the trading path. Test B inserts a
 * VALIDATED row via the real transition mechanism — that exercises the
 * MECHANISM, not production readiness. The row is isolated test data in a temp
 * DB, never production authority.
 *
 * Test order within this file matters: A and C run against the pristine DB (no
 * lifecycle rows); B inserts the single VALIDATED row LAST.
 *
 * Isolation: ARGUS_DB_PATH points at a temp SQLite file set BEFORE importing
 * db-dependent modules (same pattern as src/server/db/newsRetention.test.ts).
 * Every experimental strategy's live flag is set to 'true' so the evaluated
 * set reproduces the Oct-9 forensic-audit shape: 5 CORE + 16 experimental
 * strategies (all 16 enabledEnvVar names come from config/
 * quantExperimentalStrategies.json, read from the same config production
 * loads — never hardcoded here).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ROOT = process.cwd();

/** Experimental-strategy live flags, read from the same config production loads. */
function experimentalLiveEnvVars(): string[] {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'config', 'quantExperimentalStrategies.json'), 'utf8'),
  );
  return (cfg.strategies as Array<{ enabledEnvVar: string }>).map((s) => s.enabledEnvVar);
}

/** Strip line and block comments so doc comments don't count as code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      if (idx < 0) return line;
      const before = line.slice(0, idx);
      const quotes = (before.match(/['"`]/g) || []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join('\n');
}

describe('production-state certification (PRODUCTION_STATE)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let certifyProductionState: () => Promise<any>;
  let recordStrategyLifecycleTransition: (...args: any[]) => Promise<string>;
  let getStrategyLifecycleStatus: (strategyId: string) => Promise<string>;
  let resolveStrategiesForLiveEvaluation: () => Array<{ id: string }>;
  let CORE_STRATEGIES: Array<{ id: string }>;
  let expectedTotal: number;
  const experimentalVars: string[] = [];

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_prodstcert_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    // Reproduce the Oct-9 audit shape (all experimental strategies live).
    for (const v of experimentalLiveEnvVars()) {
      experimentalVars.push(v);
      process.env[v] = 'true';
    }
    // Paper-only lock, as in the real deployment the audit examined.
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.LIVE_ARM;

    ({ sqliteDb } = await import('../db/index'));
    ({ certifyProductionState } = await import('./productionStateCertification'));
    ({
      recordStrategyLifecycleTransition,
      getStrategyLifecycleStatus,
    } = await import('../quant/strategies/StrategyEmissionEligibility'));
    ({ resolveStrategiesForLiveEvaluation, CORE_STRATEGIES } = await import(
      '../quant/strategies/StrategyEngine'
    ));
    expectedTotal = resolveStrategiesForLiveEvaluation().length;
    expect(expectedTotal).toBeGreaterThan(0);
  }, 60000);

  afterAll(() => {
    try {
      sqliteDb?.close?.();
    } catch {
      /* best effort */
    }
    for (const suffix of ['', '-shm', '-wal']) {
      try {
        fs.unlinkSync(tmpDbPath + suffix);
      } catch {
        /* best-effort cleanup */
      }
    }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.PAPER_TRADING_ONLY;
    for (const v of experimentalVars) delete process.env[v];
  });

  it('Test A (the Oct-9 shape): no lifecycle rows -> 0 authorized -> QUANT_FIRST_OPERATIONALLY_INACTIVE = FAIL', async () => {
    const cert = await certifyProductionState();

    // The registry set, not a hardcoded literal: the Oct-9 audit saw 21.
    expect(cert.TOTAL_STRATEGIES).toBe(expectedTotal);
    expect(cert.ENABLED_QUANT_STRATEGIES).toBe(cert.TOTAL_STRATEGIES);
    expect(cert.readOnly).toBe(true);

    // No lifecycle rows at all: the Oct-9 shape (20 missing there; all missing here).
    expect(cert.LIFECYCLE_ROWS).toBe(0);
    expect(cert.MISSING_LIFECYCLE_ROWS).toBe(expectedTotal);
    for (const [state, count] of Object.entries(cert.lifecycleStateCounts)) {
      expect(count, `lifecycleStateCounts.${state} must be 0 on a pristine DB`).toBe(0);
    }

    // The mandatory invariant: zero authorized strategies FAILS certification.
    expect(cert.AUTHORIZED_PAPER_QUANT_STRATEGIES).toBe(0);
    expect(cert.verdict).toBe('QUANT_FIRST_OPERATIONALLY_INACTIVE');
    expect(cert.passed).toBe(false);

    // Per-strategy rows: every strategy terminally NOT_AUTHORIZED, missing record.
    expect(cert.details).toHaveLength(expectedTotal);
    for (const row of cert.details) {
      expect(row.authorized).toBe(false);
      expect(row.lifecycleRecord).toBe(false);
      expect(row.lifecycleStatus).toBeNull();
      expect(row.reason).toBe('NO_LIFECYCLE_RECORD');
    }
  });

  it('Test C (mandatory invariant): quantPolicyEnabled=true with 0 authorized still FAILS', async () => {
    const cert = await certifyProductionState();

    // The policy switch is ON — and that must NOT rescue a zero-authority desk.
    expect(cert.quantPolicyEnabled).toBe(true);
    expect(cert.paperOnlyEnforced).toBe(true);
    expect(cert.AUTHORIZED_PAPER_QUANT_STRATEGIES).toBe(0);
    expect(cert.verdict).toBe('QUANT_FIRST_OPERATIONALLY_INACTIVE');
    expect(cert.passed).toBe(false);
  });

  it('Test B (positive control): one real VALIDATED row via the canonical transition mechanism -> 1 authorized -> PASS', async () => {
    // MECHANISM_E2E, not production authority: this row is isolated test data in a
    // temp DB. It proves (a) the transition mechanism itself works and (b) the
    // invariant is not a constant-FAIL — nothing more.
    const strategyId = CORE_STRATEGIES[0].id;
    const rowId = await recordStrategyLifecycleTransition(
      strategyId,
      'VALIDATED',
      'PRODUCTION_STATE_CERTIFICATION positive-control fixture (MECHANISM_E2E): isolated test DB only, not production authority',
      { testControl: true, backtestWinRate: 0.62, sampleTrades: 120 },
      120,
    );
    expect(rowId).toBeTruthy();
    expect(await getStrategyLifecycleStatus(strategyId)).toBe('VALIDATED');

    const cert = await certifyProductionState();

    expect(cert.AUTHORIZED_PAPER_QUANT_STRATEGIES).toBe(1);
    expect(cert.verdict).toBe('QUANT_FIRST_OPERATIONAL');
    expect(cert.passed).toBe(true);
    expect(cert.LIFECYCLE_ROWS).toBe(1);
    expect(cert.MISSING_LIFECYCLE_ROWS).toBe(expectedTotal - 1);
    expect(cert.lifecycleStateCounts.VALIDATED).toBe(1);

    const row = cert.details.find((d: any) => d.strategyId === strategyId);
    expect(row).toBeDefined();
    expect(row.authorized).toBe(true);
    expect(row.lifecycleRecord).toBe(true);
    expect(row.lifecycleStatus).toBe('VALIDATED');
    expect(row.reason).toBe('STRATEGY_VALIDATED');

    // Everything else is still missing its record — the fixture changed exactly one row.
    expect(
      cert.details.filter((d: any) => d.strategyId !== strategyId && d.authorized).length,
    ).toBe(0);
  });
});

describe('lifecycle promotion route probe (PRODUCTION_STATE — honest finding, never a promotion)', () => {
  it('reports whether any production (non-test) code path can record VALIDATED/CHAMPION lifecycle state', async () => {
    // 1. The canonical mechanism exists and is the one every path must use.
    const mod = await import('../quant/strategies/StrategyEmissionEligibility');
    expect(typeof mod.recordStrategyLifecycleTransition).toBe('function');

    // 2. Static scan: production (non-test) .ts files under src/ whose code calls
    // recordStrategyLifecycleTransition with a VALIDATED or CHAMPION status.
    // The definition module itself is excluded (it contains the string in its
    // own promotedAt logic, not in a call site).
    const hits: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '.venv' || name === 'archive') continue;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) out.push(...walk(p));
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
      }
      return out;
    };
    for (const f of walk(path.join(ROOT, 'src'))) {
      if (f.endsWith('quant/strategies/StrategyEmissionEligibility.ts')) continue;
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      const callRe = /recordStrategyLifecycleTransition\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(code)) !== null) {
        // Argument window: the next 600 source chars after the call. A genuine
        // promotion call passes the status literal right there; doc mentions of
        // 'VALIDATED' elsewhere in the file do not count.
        const window = code.slice(m.index, m.index + 600);
        if (/['"]VALIDATED['"]/.test(window) || /['"]CHAMPION['"]/.test(window)) {
          hits.push(path.relative(ROOT, f).split(path.sep).join('/'));
          break;
        }
      }
    }

    // 3. Report the finding honestly. The test asserts the CHECK ran and the
    // finding is recorded — it does not pass/fail on promotion itself, and it
    // never auto-promotes or seeds anything to change the answer.
    const finding = hits.length === 0 ? 'ABSENT' : 'PRESENT';
    expect(['ABSENT', 'PRESENT']).toContain(finding);
    // eslint-disable-next-line no-console
    console.log(
      `[production-state-certification] LIFECYCLE_PROMOTION_ROUTE=${finding}` +
        (hits.length > 0 ? ` callers=${JSON.stringify(hits)}` : ' (no production call site records VALIDATED/CHAMPION)') +
        ' | note: scripts/soak/threeHourSoakChild.ts contains a labeled SOAK_FIXTURE VALIDATED call (test tooling, not production authority)',
    );
  });
});
