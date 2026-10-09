// LABEL: UNIT - proves the authorization rule (only VALIDATED/CHAMPION lifecycle authorizes; emitters cannot self-grant) against a temp DB. Tests the logic itself; seeded rows ARE the test subject, not production authority.
/**
 * QuantStrategyAuthorization tests (Quant-First Decision Architecture, Phase 16).
 *
 * Proves the central authorization rule: provenance is descriptive, authority is verified.
 * - No emitter can self-grant quant authority via origin/strategyId metadata.
 * - Only VALIDATED/CHAMPION lifecycle (DB-backed, explicit operator decision) authorizes.
 * - UNTESTED/SHADOW/CANDIDATE/ACTIVE_EXPLORATION/ROLLED_BACK keep the consensus path.
 * - DEGRADED/RETIRED are terminally NOT_ELIGIBLE; LIVE env is NOT_ELIGIBLE.
 *
 * Strategy ids are derived from the production registry (CORE_STRATEGIES), never literals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CORE_STRATEGIES } from './strategies/StrategyEngine';

describe('QuantStrategyAuthorization', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let authz: typeof import('./QuantStrategyAuthorization');
  let eligibility: typeof import('./strategies/StrategyEmissionEligibility');
  let policyCfg: typeof import('../config/quantDecisionPolicy');

  const STRATEGY_ID = CORE_STRATEGIES[0].id;
  const OTHER_STRATEGY_ID = CORE_STRATEGIES[1].id;
  // Untouched by every other test in this file: NO_RECORD_STRATEGY_ID must have zero
  // learning_versions rows for the missing-record tests; RETIRED_STRATEGY_ID and
  // EXPLORATION_STRATEGY_ID carry their own explicit rows per test below.
  const NO_RECORD_STRATEGY_ID = CORE_STRATEGIES[2].id;
  const RETIRED_STRATEGY_ID = CORE_STRATEGIES[3].id;
  const EXPLORATION_STRATEGY_ID = CORE_STRATEGIES[4].id;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['ARGUS_DB_PATH', 'PAPER_TRADING_ONLY']) savedEnv[k] = process.env[k];
    tmpDbPath = path.join(os.tmpdir(), `argus_quant_authz_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    // Dynamic imports AFTER ARGUS_DB_PATH is set (same proven pattern as
    // StrategyEmissionEligibility.test.ts): the db module migrates on first import.
    ({ sqliteDb } = await import('../db'));
    authz = await import('./QuantStrategyAuthorization');
    eligibility = await import('./strategies/StrategyEmissionEligibility');
    policyCfg = await import('../config/quantDecisionPolicy');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const quantIdea = (overrides: Record<string, unknown> = {}) => ({
    origin: 'QUANT_STRATEGY',
    strategyId: STRATEGY_ID,
    agent: 'QuantEngine',
    ...overrides,
  });

  it('a non-quant origin never reaches authorization (REQUIRES_CONSENSUS)', async () => {
    for (const origin of ['AI_RESEARCH', 'NEWS_EVENT', 'TECHNICAL', 'OTHER', undefined, null, '']) {
      const r = await authz.resolveQuantStrategyAuthorization({ origin, strategyId: STRATEGY_ID, agent: 'QuantEngine' });
      expect(r.authority).toBe('REQUIRES_CONSENSUS');
      expect(r.reason).toBe('ORIGIN_NOT_QUANT');
    }
  });

  it("a forged 'QUANT_VALIDATED' origin normalizes to OTHER and cannot authorize", async () => {
    // The dangerous failure mode from the mission prompt: an emitter granting itself
    // authority via metadata. QUANT_VALIDATED is not a valid origin at all.
    const r = await authz.resolveQuantStrategyAuthorization({
      origin: 'QUANT_VALIDATED',
      strategyId: STRATEGY_ID,
      agent: 'QuantEngine',
    });
    expect(r.origin).toBe('OTHER');
    expect(r.authority).toBe('REQUIRES_CONSENSUS');
    expect(r.reason).toBe('ORIGIN_NOT_QUANT');
  });

  it('missing strategyId falls back to consensus (never authorized, never terminal)', async () => {
    for (const strategyId of [undefined, null, '', '   ']) {
      const r = await authz.resolveQuantStrategyAuthorization({ origin: 'QUANT_STRATEGY', strategyId, agent: 'QuantEngine' });
      expect(r.authority).toBe('REQUIRES_CONSENSUS');
      expect(r.reason).toBe('NO_STRATEGY_ID');
    }
  });

  it('an unknown strategyId cannot use the quant policy', async () => {
    const r = await authz.resolveQuantStrategyAuthorization({
      origin: 'QUANT_STRATEGY',
      strategyId: 'NO_SUCH_STRATEGY_XYZ',
      agent: 'QuantEngine',
    });
    expect(r.authority).toBe('REQUIRES_CONSENSUS');
    expect(r.reason).toBe('UNKNOWN_STRATEGY');
  });

  it('a non-producer agent cannot claim quant authority even with a real strategyId (Phase 21)', async () => {
    // Validate the strategy first so the ONLY failing check is the producer.
    await eligibility.recordStrategyLifecycleTransition(STRATEGY_ID, 'VALIDATED', 'test', null, 10);
    try {
      for (const agent of ['NewsAgent', 'TechnicalAgent', 'MacroAgent', 'ConsensusDebate', 'BullResearcher', 'KronosForecastAgent']) {
        const r = await authz.resolveQuantStrategyAuthorization({ origin: 'QUANT_STRATEGY', strategyId: STRATEGY_ID, agent });
        expect(r.authority).toBe('REQUIRES_CONSENSUS');
        expect(r.reason).toBe('PRODUCER_NOT_QUANT');
      }
    } finally {
      await eligibility.recordStrategyLifecycleTransition(OTHER_STRATEGY_ID, 'UNTESTED', 'cleanup', null, 0);
    }
  });

  it('recorded UNTESTED keeps the consensus path — no behavior change', async () => {
    // OTHER_STRATEGY_ID carries a recorded UNTESTED row from the producer test's cleanup above:
    // an EXPLICIT decision exists, so consensus-path routing is unchanged. A strategy with NO
    // row at all is a different case (NOT_AUTHORIZED) — see the next test.
    expect(await eligibility.hasStrategyLifecycleRecord(OTHER_STRATEGY_ID)).toBe(true);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea({ strategyId: OTHER_STRATEGY_ID }));
    expect(r.authority).toBe('REQUIRES_CONSENSUS');
    expect(r.reason).toBe('STRATEGY_UNTESTED');
    expect(r.lifecycleStatus).toBe('UNTESTED');
  });

  it('a strategy with no lifecycle record at all is NOT_AUTHORIZED (NO_LIFECYCLE_RECORD) — missing state is never silently UNTESTED', async () => {
    // Defect #1: four CORE strategies traded in production with zero learning_versions rows.
    // A missing record is visible missing state, never privilege: it must not inherit the
    // UNTESTED default's semantics silently. This is distinct from a transient lookup failure
    // (STRATEGY_LIFECYCLE_LOOKUP_FAILED, which keeps the consensus path).
    expect(await eligibility.hasStrategyLifecycleRecord(NO_RECORD_STRATEGY_ID)).toBe(false);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea({ strategyId: NO_RECORD_STRATEGY_ID }));
    expect(r.authority).toBe('NOT_AUTHORIZED');
    expect(r.reason).toBe('NO_LIFECYCLE_RECORD');
    // lifecycleStatus stays null: reporting 'UNTESTED' would falsely imply a recorded decision.
    expect(r.lifecycleStatus).toBeNull();
    // Emission eligibility is a different concept: a missing record is not quarantined, so the
    // strategy may still emit ideas into intake — but none may use the quant execution policy.
    expect(await authz.mayEmitStrategyIdea(NO_RECORD_STRATEGY_ID)).toBe(true);
  });

  it.each([
    ['SHADOW', 'STRATEGY_SHADOW'],
    ['CANDIDATE', 'STRATEGY_CANDIDATE'],
    ['ACTIVE_EXPLORATION', 'STRATEGY_ACTIVE_EXPLORATION'],
    ['ROLLED_BACK', 'STRATEGY_ROLLED_BACK'],
  ] as const)('%s lifecycle keeps the consensus path', async (status, reason) => {
    await eligibility.recordStrategyLifecycleTransition(OTHER_STRATEGY_ID, status, 'test', null, 5);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea({ strategyId: OTHER_STRATEGY_ID }));
    expect(r.authority).toBe('REQUIRES_CONSENSUS');
    expect(r.reason).toBe(reason);
    expect(r.lifecycleStatus).toBe(status);
  });

  it('VALIDATED lifecycle grants AUTHORIZED_QUANT_POLICY', async () => {
    await eligibility.recordStrategyLifecycleTransition(OTHER_STRATEGY_ID, 'VALIDATED', 'test evidence', { n: 40 }, 40);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea({ strategyId: OTHER_STRATEGY_ID }));
    expect(r.authority).toBe('AUTHORIZED_QUANT_POLICY');
    expect(r.reason).toBe('STRATEGY_VALIDATED');
    expect(r.lifecycleStatus).toBe('VALIDATED');
  });

  it('CHAMPION lifecycle grants AUTHORIZED_QUANT_POLICY', async () => {
    await eligibility.recordStrategyLifecycleTransition(OTHER_STRATEGY_ID, 'CHAMPION', 'test evidence', null, 60);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea({ strategyId: OTHER_STRATEGY_ID }));
    expect(r.authority).toBe('AUTHORIZED_QUANT_POLICY');
    expect(r.reason).toBe('STRATEGY_CHAMPION');
  });

  it('ACTIVE_EXPLORATION + PAPER: emission-eligible but never execution-authorized (the two predicates differ)', async () => {
    // Defect #1 evidence conclusion: ACTIVE_EXPLORATION was designed as "bounded, monitored
    // real exposure while evidence accumulates" — eligibility for the real-selection pool,
    // not AI-independent execution authority. The two named concepts must disagree here.
    await eligibility.recordStrategyLifecycleTransition(EXPLORATION_STRATEGY_ID, 'ACTIVE_EXPLORATION', 'bounded exploration test', null, 5);
    // Named concept 1 — emission eligibility: "may emit an idea" is true.
    expect(await authz.mayEmitStrategyIdea(EXPLORATION_STRATEGY_ID)).toBe(true);
    // Named concept 2 — execution authority: PAPER keeps the consensus path, never the quant policy.
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea({ strategyId: EXPLORATION_STRATEGY_ID }));
    expect(r.authority).toBe('REQUIRES_CONSENSUS');
    expect(r.reason).toBe('STRATEGY_ACTIVE_EXPLORATION');
    expect(r.lifecycleStatus).toBe('ACTIVE_EXPLORATION');
    expect(r.authority).not.toBe('AUTHORIZED_QUANT_POLICY');
  });

  it.each([
    'UNTESTED', 'SHADOW', 'CANDIDATE', 'ACTIVE_EXPLORATION', 'VALIDATED', 'CHAMPION', 'DEGRADED', 'RETIRED', 'ROLLED_BACK',
  ] as const)(
    'without the paper-only env lock, %s never gains LIVE quant authority — the env check fails first',
    async (status) => {
      // Even an explicit VALIDATED/CHAMPION row must not issue quant authority outside PAPER:
      // no lifecycle status confers LIVE authority, anywhere in this module.
      await eligibility.recordStrategyLifecycleTransition(EXPLORATION_STRATEGY_ID, status, 'live-env test', null, 5);
      delete process.env.PAPER_TRADING_ONLY;
      try {
        const r = await authz.resolveQuantStrategyAuthorization(quantIdea({ strategyId: EXPLORATION_STRATEGY_ID }));
        expect(r.authority).toBe('NOT_ELIGIBLE');
        expect(r.reason).toBe('ENVIRONMENT_NOT_AUTHORIZED');
        expect(r.authority).not.toBe('AUTHORIZED_QUANT_POLICY');
      } finally {
        process.env.PAPER_TRADING_ONLY = 'true';
      }
    },
  );

  it('RETIRED is never promoted by any lifecycle read path — retirement is sticky and read-only', async () => {
    // Defect #1: PULLBACK_CONTINUATION is RETIRED and must stay RETIRED permanently. No
    // initializer/promoter exists in the codebase (grep: no ensureLifecycle/seedLifecycle);
    // every read path the authorization layer uses must observe RETIRED and change nothing.
    await eligibility.recordStrategyLifecycleTransition(RETIRED_STRATEGY_ID, 'RETIRED', 'negative evidence', { winRate: 0.2 }, 22);
    const historyBefore = await eligibility.getStrategyLifecycleHistory(RETIRED_STRATEGY_ID);
    expect(await eligibility.getStrategyLifecycleStatus(RETIRED_STRATEGY_ID)).toBe('RETIRED');
    expect(await eligibility.hasStrategyLifecycleRecord(RETIRED_STRATEGY_ID)).toBe(true);
    expect(await eligibility.isStrategyQuarantinedForEmission(RETIRED_STRATEGY_ID)).toBe(true);
    expect(await authz.mayEmitStrategyIdea(RETIRED_STRATEGY_ID)).toBe(false);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea({ strategyId: RETIRED_STRATEGY_ID }));
    expect(r.authority).toBe('NOT_ELIGIBLE');
    expect(r.reason).toBe('STRATEGY_RETIRED');
    // None of the read paths above appended, mutated, or promoted anything: the latest
    // decision is still RETIRED and the history is byte-identical.
    const historyAfter = await eligibility.getStrategyLifecycleHistory(RETIRED_STRATEGY_ID);
    expect(historyAfter.map((h) => h.status)).toEqual(historyBefore.map((h) => h.status));
    expect(historyAfter[0].status).toBe('RETIRED');
  });

  it.each([
    ['DEGRADED', 'STRATEGY_DEGRADED'],
    ['RETIRED', 'STRATEGY_RETIRED'],
  ] as const)('%s lifecycle is terminally NOT_ELIGIBLE (never re-routed to consensus)', async (status, reason) => {
    await eligibility.recordStrategyLifecycleTransition(OTHER_STRATEGY_ID, status, 'negative evidence', null, 30);
    const r = await authz.resolveQuantStrategyAuthorization(quantIdea({ strategyId: OTHER_STRATEGY_ID }));
    expect(r.authority).toBe('NOT_ELIGIBLE');
    expect(r.reason).toBe(reason);
  });

  it('without the paper-only env lock, the quant path is NOT_ELIGIBLE (LIVE fail-closed)', async () => {
    await eligibility.recordStrategyLifecycleTransition(STRATEGY_ID, 'VALIDATED', 'test', null, 10);
    delete process.env.PAPER_TRADING_ONLY;
    try {
      const r = await authz.resolveQuantStrategyAuthorization(quantIdea());
      expect(r.authority).toBe('NOT_ELIGIBLE');
      expect(r.reason).toBe('ENVIRONMENT_NOT_AUTHORIZED');
    } finally {
      process.env.PAPER_TRADING_ONLY = 'true';
    }
  });

  it('master switch off routes everything to consensus (pre-change behavior)', async () => {
    await eligibility.recordStrategyLifecycleTransition(STRATEGY_ID, 'VALIDATED', 'test', null, 10);
    policyCfg.quantDecisionPolicy.quantPolicyEnabled = false;
    try {
      const r = await authz.resolveQuantStrategyAuthorization(quantIdea());
      expect(r.authority).toBe('REQUIRES_CONSENSUS');
      expect(r.reason).toBe('POLICY_DISABLED');
    } finally {
      policyCfg.quantDecisionPolicy.quantPolicyEnabled = true;
    }
  });

  it('a lifecycle lookup failure fails closed to consensus, never to authorized', async () => {
    // Close the DB out from under the resolver to force a lookup throw.
    sqliteDb.close();
    try {
      const r = await authz.resolveQuantStrategyAuthorization(quantIdea());
      expect(r.authority).toBe('REQUIRES_CONSENSUS');
      expect(r.reason).toBe('STRATEGY_LIFECYCLE_LOOKUP_FAILED');
    } finally {
      // Reopen for afterAll cleanup (best-effort; afterAll guards close errors).
      try {
        const fresh = await import('../db');
        sqliteDb = fresh.sqliteDb;
      } catch { /* afterAll tolerates */ }
    }
  });
});
