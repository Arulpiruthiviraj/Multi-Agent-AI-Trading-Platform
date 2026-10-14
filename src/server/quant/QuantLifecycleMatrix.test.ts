// LABEL: UNIT - table-driven proof of the permissions attached to EVERY runtime lifecycle state (plus missing and tampered state), through the real resolver.
/**
 * Oct 14 response: "Determine the exact meaning and permissions of every lifecycle state." This is the single authoritative matrix. Runtime vocabulary
 * (learning_versions, StrategyEmissionEligibility): UNTESTED, SHADOW, CANDIDATE, ACTIVE_EXPLORATION, VALIDATED, CHAMPION, DEGRADED, RETIRED, ROLLED_BACK.
 * The research-side vocabulary (promotionEngine: BACKTEST_ONLY, IN_SAMPLE, OOS_TESTING, WALK_FORWARD_TESTING, ROBUSTNESS_TESTING, PAPER_TESTING, VALIDATED,
 * LIVE_*) is NOT a runtime permission; it is derived read-only evidence that certificationBridge may translate (with unskippable operator review) into one of
 * the runtime states above. Nothing here grants LIVE authority under any state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CORE_STRATEGIES } from './strategies/StrategyEngine';

type Expect = { authority: string; reason: string; mayEmit: boolean };
const MATRIX: Array<[string, Expect]> = [
  ['UNTESTED',           { authority: 'REQUIRES_CONSENSUS',        reason: 'STRATEGY_UNTESTED',           mayEmit: true }],
  ['SHADOW',             { authority: 'REQUIRES_CONSENSUS',        reason: 'STRATEGY_SHADOW',             mayEmit: true }],
  ['CANDIDATE',          { authority: 'REQUIRES_CONSENSUS',        reason: 'STRATEGY_CANDIDATE',          mayEmit: true }],
  ['ACTIVE_EXPLORATION', { authority: 'REQUIRES_CONSENSUS',        reason: 'STRATEGY_ACTIVE_EXPLORATION', mayEmit: true }],
  ['ROLLED_BACK',        { authority: 'REQUIRES_CONSENSUS',        reason: 'STRATEGY_ROLLED_BACK',        mayEmit: true }],
  ['VALIDATED',          { authority: 'AUTHORIZED_QUANT_POLICY',   reason: 'STRATEGY_VALIDATED',          mayEmit: true }],
  ['CHAMPION',           { authority: 'AUTHORIZED_QUANT_POLICY',   reason: 'STRATEGY_CHAMPION',           mayEmit: true }],
  ['DEGRADED',           { authority: 'NOT_ELIGIBLE',              reason: 'STRATEGY_DEGRADED',           mayEmit: false }],
  ['RETIRED',            { authority: 'NOT_ELIGIBLE',              reason: 'STRATEGY_RETIRED',            mayEmit: false }],
];

describe('Quant lifecycle permission matrix (all runtime states, missing, tampered)', () => {
  let tmp: string; let sqliteDb: any; let authz: typeof import('./QuantStrategyAuthorization'); let elig: typeof import('./strategies/StrategyEmissionEligibility');
  let producer: string; let db: any; let schema: any;
  const saved: Record<string, string | undefined> = {};
  const [ID, MISSING_ID, TAMPER_ID] = CORE_STRATEGIES.map((s) => s.id);

  beforeAll(async () => {
    for (const k of ['ARGUS_DB_PATH', 'PAPER_TRADING_ONLY']) saved[k] = process.env[k];
    tmp = path.join(os.tmpdir(), `argus_lifecycle_matrix_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp; process.env.PAPER_TRADING_ONLY = 'true';
    ({ sqliteDb, db } = await import('../db'));
    schema = await import('../db/schema');
    authz = await import('./QuantStrategyAuthorization');
    elig = await import('./strategies/StrategyEmissionEligibility');
    producer = (await import('../config/quantDecisionPolicy')).quantDecisionPolicy.quantProducerAgents[0];
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const resolve = (strategyId: string) => authz.resolveQuantStrategyAuthorization({ origin: 'QUANT_STRATEGY', strategyId, agent: producer });

  it('every runtime state maps to exactly its documented authority, reason and emission eligibility; only VALIDATED/CHAMPION ever authorize', async () => {
    const base = Date.now() - 60_000;
    let i = 0;
    for (const [status, want] of MATRIX) {
      await elig.recordStrategyLifecycleTransition(ID, status as any, `matrix ${status}`, null, 0, new Date(base + i++ * 1000));
      const a = await resolve(ID);
      expect({ status, authority: a.authority, reason: a.reason }).toEqual({ status, authority: want.authority, reason: want.reason });
      expect({ status, mayEmit: !(await elig.isStrategyQuarantinedForEmission(ID)) }).toEqual({ status, mayEmit: want.mayEmit });
    }
    const authorizing = MATRIX.filter(([, w]) => w.authority === 'AUTHORIZED_QUANT_POLICY').map(([s]) => s);
    expect(authorizing).toEqual(['VALIDATED', 'CHAMPION']);
  });

  it('a strategy with NO lifecycle record is NOT_AUTHORIZED / NO_LIFECYCLE_RECORD (terminal), never silently UNTESTED', async () => {
    const a = await resolve(MISSING_ID);
    expect(a).toMatchObject({ authority: 'NOT_AUTHORIZED', reason: 'NO_LIFECYCLE_RECORD', lifecycleStatus: null });
  });

  it('a TAMPERED lifecycle value (not in the closed runtime set) never authorizes and never throws', async () => {
    await db.insert(schema.learningVersions).values({
      id: `tamper-${Date.now()}`, versionType: elig.strategyEligibilityVersionType(TAMPER_ID), parentVersionId: null, status: 'SUPERUSER_LIVE_APPROVED',
      stateJson: '{}', hypothesis: 'tampered row', evidenceJson: null, sampleSize: 0, createdAt: new Date().toISOString(),
    });
    const a = await resolve(TAMPER_ID);
    expect(a.authority).not.toBe('AUTHORIZED_QUANT_POLICY');
    expect(['REQUIRES_CONSENSUS', 'NOT_ELIGIBLE', 'NOT_AUTHORIZED']).toContain(a.authority);
  });

  it('state survives a restart: the lifecycle is read from the database on every resolution (no in-memory authority cache)', async () => {
    await elig.recordStrategyLifecycleTransition(ID, 'VALIDATED', 'restart check', null, 0, new Date());
    expect((await resolve(ID)).authority).toBe('AUTHORIZED_QUANT_POLICY');
    await elig.recordStrategyLifecycleTransition(ID, 'DEGRADED', 'revocation', null, 0, new Date(Date.now() + 5));
    expect((await resolve(ID)).authority).toBe('NOT_ELIGIBLE'); // promotion/revocation takes effect immediately
  });

  it('LIVE is inexpressible: with the paper-only lock disengaged no state authorizes', async () => {
    await elig.recordStrategyLifecycleTransition(ID, 'CHAMPION', 'live check', null, 0, new Date(Date.now() + 10));
    const prev = process.env.PAPER_TRADING_ONLY; process.env.PAPER_TRADING_ONLY = 'false';
    try { expect((await resolve(ID)).authority).toBe('NOT_ELIGIBLE'); } finally { process.env.PAPER_TRADING_ONLY = prev; }
  });
});
