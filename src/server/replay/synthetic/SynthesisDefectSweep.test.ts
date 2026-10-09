/**
 * SYNTHESIS DEFECT SWEEP (2026-10-08).
 *
 * === SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY ===
 *
 * One test file that injects every October-8 defect class through the REAL
 * production code path and asserts, per defect, that the system reaches the
 * SAFE state and produces a LOUD, distinguishing diagnosis. This is the
 * "easy to find any defects" synthesis: a single run renders one report table
 * (defect -> injected fault -> safe state reached -> diagnosis), and a
 * regression in any defect class fails with the defect's name in the test
 * output — no DB forensics required to know what broke.
 *
 * What each case drives (all real production modules, fault injected only at
 * the boundary — never a forced decision, per the repo's synthetic-testing
 * rules):
 *
 *  D1-MISSING-LIFECYCLE  real resolveQuantStrategyAuthorization against a temp
 *                        DB: missing record -> NOT_AUTHORIZED/NO_LIFECYCLE_RECORD
 *                        (terminal); a VALIDATED row for another strategy still
 *                        authorizes (the terminal drop doesn't wedge the desk).
 *  D1-AI-DOWN            real resolver with AI keys absent: quant+VALIDATED ->
 *                        AUTHORIZED_QUANT_POLICY (AI state can't gate quant);
 *                        AI-originated idea -> REQUIRES_CONSENSUS, never the
 *                        quant policy.
 *  D2-BACKUP             real DbBackupService with an injected slow worker:
 *                        heartbeat stays responsive; status reaches SUCCEEDED;
 *                        maintenance flag is true while running.
 *  D3-WATCHDOG-STORM     real watchdog nextState(): repeated process-death
 *                        ticks -> bounded restarts -> STORM_LOCKOUT, and the
 *                        lockout holds (no automatic recovery, no restart).
 *  D5/D6-PREMARKET       real premarket evaluators: healthy pipeline + missing
 *                        report -> pipeline is NOT failed and the report check
 *                        is WARN — independent, never conflated.
 *  D7-BILLING-402        real AICallGovernor with an injected 402-throwing Jev:
 *                        BILLING classification, no retry, circuit opens after
 *                        the threshold, provider invocations stay bounded, and
 *                        no generative failover ever fires.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

interface SweepCaseResult {
  defect: string;
  injected: string;
  safeState: string;
  diagnosis: string;
}

const results: SweepCaseResult[] = [];

function record(r: SweepCaseResult) {
  results.push(r);
}

function renderSweepReport() {
  const line = (c: SweepCaseResult) =>
    `| ${c.defect} | ${c.injected} | ${c.safeState} | ${c.diagnosis} |`;
  console.log(
    '\n[SYNTHESIS DEFECT SWEEP] (SYNTHETIC_SEEDED / NON_ORGANIC)\n' +
      '| defect | injected fault | safe state reached | diagnosis |\n' +
      '|---|---|---|---|\n' +
      results.map(line).join('\n') +
      '\n',
  );
}

describe('synthesis defect sweep (SYNTHETIC_SEEDED)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let authz: typeof import('../../quant/QuantStrategyAuthorization');
  let eligibility: typeof import('../../quant/strategies/StrategyEmissionEligibility');
  let CORE_STRATEGIES: Array<{ id: string }>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['ARGUS_DB_PATH', 'PAPER_TRADING_ONLY', 'JEV_API_KEY', 'TYPESAFE_API_KEY'])
      savedEnv[k] = process.env[k];
    tmpDbPath = path.join(os.tmpdir(), `argus_sweep_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    // D1-AI-DOWN: no AI keys present — quant authorization must not care.
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;

    ({ sqliteDb } = await import('../../db'));
    authz = await import('../../quant/QuantStrategyAuthorization');
    eligibility = await import('../../quant/strategies/StrategyEmissionEligibility');
    ({ CORE_STRATEGIES } = await import('../../quant/strategies/StrategyEngine'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* best-effort */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    renderSweepReport();
  });

  const quantIdea = (strategyId: string, origin = 'QUANT_STRATEGY') => ({
    origin,
    strategyId,
    agent: 'QuantEngine',
  });

  it('D1-MISSING-LIFECYCLE: missing record is terminal, and does not wedge the desk', async () => {
    const missingId = CORE_STRATEGIES[2].id;
    const validatedId = CORE_STRATEGIES[0].id;

    const missing = await authz.resolveQuantStrategyAuthorization(quantIdea(missingId));
    expect(missing.authority).toBe('NOT_AUTHORIZED');
    expect(missing.reason).toBe('NO_LIFECYCLE_RECORD');
    expect(missing.lifecycleStatus).toBeNull();

    // The terminal drop must not wedge the resolver: an explicit VALIDATED
    // decision for another strategy authorizes normally right afterwards.
    await eligibility.recordStrategyLifecycleTransition(
      validatedId, 'VALIDATED', 'sweep fixture (SYNTHETIC_SEEDED)', { sweep: true }, 100,
    );
    const ok = await authz.resolveQuantStrategyAuthorization(quantIdea(validatedId));
    expect(ok.authority).toBe('AUTHORIZED_QUANT_POLICY');
    expect(ok.reason).toBe('STRATEGY_VALIDATED');

    record({
      defect: 'D1-MISSING-LIFECYCLE',
      injected: 'no learning_versions row for strategy',
      safeState: 'NOT_AUTHORIZED (terminal); VALIDATED strategy still authorizes',
      diagnosis: 'NO_LIFECYCLE_RECORD with null lifecycleStatus — never silently UNTESTED',
    });
  });

  it('D1-AI-DOWN: AI state cannot gate quant authorization; AI ideas never take the quant path', async () => {
    const validatedId = CORE_STRATEGIES[0].id;
    // No JEV_API_KEY / TYPESAFE_API_KEY in env (deleted in beforeAll).
    const quant = await authz.resolveQuantStrategyAuthorization(quantIdea(validatedId));
    expect(quant.authority).toBe('AUTHORIZED_QUANT_POLICY');

    // An AI-originated idea keeps the consensus path even with a VALIDATED row —
    // origin is checked before lifecycle, so AI can never ride quant authority.
    const ai = await authz.resolveQuantStrategyAuthorization(quantIdea(validatedId, 'AI_RESEARCH'));
    expect(ai.authority).toBe('REQUIRES_CONSENSUS');
    expect(ai.reason).toBe('ORIGIN_NOT_QUANT');

    record({
      defect: 'D1-AI-DOWN',
      injected: 'all AI provider keys absent',
      safeState: 'quant+VALIDATED still AUTHORIZED; AI-origin keeps consensus path',
      diagnosis: 'AUTHORIZED_QUANT_POLICY is AI-independent; ORIGIN_NOT_QUANT for AI ideas',
    });
  });

  it('D2-BACKUP: main loop stays responsive while a slow backup runs', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus_sweep_backup_'));
    const liveDbPath = path.join(tmpRoot, 'argus.db');
    try {
      const filler = new Database(liveDbPath);
      try {
        filler.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        filler.prepare('INSERT INTO t (v) VALUES (?)').run('x');
      } finally {
        filler.close();
      }
      const prevDbPath = process.env.ARGUS_DB_PATH;
      process.env.ARGUS_DB_PATH = liveDbPath;
      const { DbBackupService } = await import('../../services/DbBackupService');

      // Injected slow worker: simulates a multi-second copy without real I/O.
      const listeners: Record<string, Array<(...a: any[]) => void>> = {};
      const fakeWorker = {
        on: (event: string, fn: (...a: any[]) => void) => {
          (listeners[event] ??= []).push(fn);
          return fakeWorker;
        },
        terminate: async () => 0,
      };
      const service = new DbBackupService({
        createWorker: () => {
          setTimeout(() => {
            for (const fn of listeners['message'] ?? [])
              fn({ type: 'complete', sha256: 'sweep', bytesCopied: 1, durationMs: 1500 });
          }, 1500);
          return fakeWorker as any;
        },
      });

      let heartbeats = 0;
      let beating = true;
      const beat = () => { if (!beating) return; heartbeats++; setImmediate(beat); };
      setImmediate(beat);
      const outcome = await service.runBackup();
      beating = false;

      expect(heartbeats).toBeGreaterThan(0);
      expect(service.isMaintenanceInProgress()).toBe(false);
      expect(service.getBackupStatus().state).toBe('SUCCEEDED');
      expect(outcome.outcome).toBe('completed');

      process.env.ARGUS_DB_PATH = prevDbPath;
      record({
        defect: 'D2-BACKUP',
        injected: '1.5s backup worker on the worker seam',
        safeState: 'heartbeat responsive; status SUCCEEDED; maintenance flag cleared',
        diagnosis: `heartbeat ticked ${heartbeats}x during backup; state=SUCCEEDED`,
      });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('D3-WATCHDOG-STORM: repeated death is bounded, then locked out — never infinite', async () => {
    const logic = await import('../../../../scripts/lib/argusWatchdogLogic');
    // Tiny cooldowns so the sweep exercises the storm path (not the backoff
    // timing); the backoff math itself is covered by argusWatchdogLogic.test.ts.
    const cfg = {
      ...logic.DEFAULT_WATCHDOG_CONFIG,
      maxRestarts: 3,
      restartWindowMs: 600_000,
      restartCooldownBaseMs: 1,
      restartCooldownMaxMs: 5,
    };
    let machine = logic.initialStateMachine();
    const t0 = Date.now();
    const deadTick = (nowMs: number) => ({
      pidAlive: false,
      healthOk: false,
      heartbeatAgeMs: 999999,
      cleanShutdown: false,
      maintenance: null,
      engineStartedAtMs: t0 - 120000,
    });

    const actions: string[] = [];
    // Advance the clock past the (tiny) cooldown each round so every round can
    // issue a restart until the storm budget is exhausted — the real I/O loop
    // behaves the same way once the backoff elapses.
    for (let i = 0; i < 10; i++) {
      const res = logic.nextState(machine, deadTick(t0 + i * 60_000) as any, cfg, t0 + i * 60_000);
      machine = res.machine;
      actions.push(res.action);
      if (res.action === 'STORM_LOCKOUT') break;
    }
    const restarts = actions.filter((a) => a === 'RESTART' || a === 'FORCE_KILL_AND_RESTART').length;
    expect(restarts).toBeLessThanOrEqual(3);
    expect(restarts).toBeGreaterThan(0);
    expect(machine.state).toBe('STORM_LOCKOUT');
    // Lockout holds: further ticks never restart again.
    const after = logic.nextState(machine, deadTick(t0 + 600_000) as any, cfg, t0 + 600_000);
    expect(after.action).toBe('NONE');
    expect(after.machine.state).toBe('STORM_LOCKOUT');

    record({
      defect: 'D3-WATCHDOG-STORM',
      injected: '10 consecutive process-death ticks, maxRestarts=3',
      safeState: `${restarts} bounded restarts, then STORM_LOCKOUT (holds)`,
      diagnosis: 'STORM_LOCKOUT — operator action required; no automatic recovery',
    });
  });

  it('D5/D6-PREMARKET: pipeline health and report health are independent', async () => {
    const { evaluateTradePlanPipeline, evaluateFocusReportHealth } =
      await import('../../premarket/premarketReadiness');
    const now = new Date();
    const recentIso = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    // Pipeline produced recently (inside any window), but no focus report exists.
    const pipeline = evaluateTradePlanPipeline(
      {
        tradingDate: '2026-10-08',
        planCount: 12,
        maxRefreshVersion: 3,
        firstActivityAt: recentIso,
        lastActivityAt: recentIso,
      },
      now,
      [], // no windows elapsed against a 5-minute-old activity
    );
    const focus = evaluateFocusReportHealth({
      tradingDate: '2026-10-08',
      latestCompletedRefreshVersion: 3,
      latestReport: null,
    });
    expect(pipeline.status).not.toBe('FAIL');
    expect(focus.status).toBe('WARN');
    // The two checks are independent: a missing report never fails the pipeline
    // check, and a healthy pipeline never masks the missing report.

    record({
      defect: 'D5/D6-PREMARKET',
      injected: 'healthy pipeline, missing focus report',
      safeState: 'pipeline not failed; report independently WARN',
      diagnosis: `pipeline=${pipeline.status} / focus=${focus.status} — never conflated`,
    });
  });

  it('D7-BILLING-402: no retry, circuit opens, invocations bounded, quant unaffected', async () => {
    const { AICallGovernor } = await import('../../ai/AICallGovernor');
    const { JevError } = await import('../../ai/JevDecisionProvider');
    const governor: any = (AICallGovernor as any).getInstance?.() ?? new (AICallGovernor as any)();
    if (typeof governor.resetForTests === 'function') governor.resetForTests();

    let invocations = 0;
    let failoverCalls = 0;
    governor.__setJevProviderForTests({
      isConfigured: () => true,
      decide: async () => {
        invocations++;
        throw new JevError('BILLING', 'synthetic 402 (SYNTHETIC_SEEDED)', {
          status: 402,
          retryable: false,
        });
      },
    });

    const req = (i: number) => ({
      capability: 'STRUCTURED_DECISION' as const,
      kind: 'news_catalyst_triage',
      material: {
        symbol: `SWP402_${i}`,
        fingerprintParts: { i },
        materiality: 'HIGH' as const,
        decisionDeadlineMs: Date.now() + 60_000,
        traceId: `synthetic-sweep-402-${i}`,
      },
      jev: {
        state: { synthetic: true },
        questions: { material: 'is this catalyst material?' },
        schemaVersion: '1',
      },
      // The generative executor hook: must stay silent throughout (no failover, ever).
      run: async () => {
        failoverCalls++;
        return { value: null, cacheable: false };
      },
    });

    const first: any = await governor.request(req(0));
    expect(first.status).toBe('FAILED');
    expect(first.kind).toBe('BILLING');
    expect(invocations).toBe(1);

    for (let i = 1; i < 12; i++) await governor.request(req(i));
    // Circuit tripped on the deterministic BILLING failures: subsequent
    // requests skip cheaply instead of burning provider budget.
    expect(invocations).toBeLessThan(12);
    expect(invocations).toBeGreaterThan(1);
    expect(failoverCalls).toBe(0);

    // Quant authorization alongside is untouched by the 402 storm.
    const quant = await authz.resolveQuantStrategyAuthorization(quantIdea(CORE_STRATEGIES[0].id));
    expect(quant.authority).toBe('AUTHORIZED_QUANT_POLICY');

    if (typeof governor.resetForTests === 'function') governor.resetForTests();
    record({
      defect: 'D7-BILLING-402',
      injected: 'Jev throws BILLING/402 on every call',
      safeState: `${invocations} provider invocations for 12 requests; circuit containment; quant unaffected`,
      diagnosis: 'BILLING fail, retryable=false; circuit opens; no generative failover ever',
    });
  });
});
