// LABEL: UNIT - proves the operator lifecycle baseline writes only UNTESTED, only for CORE strategies, never overwrites, and grants no authority.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CORE_STRATEGIES } from './StrategyEngine';

describe('lifecycleBaseline', () => {
  let tmp: string; let sqliteDb: any;
  let base: typeof import('./lifecycleBaseline');
  let elig: typeof import('./StrategyEmissionEligibility');
  let authz: typeof import('../QuantStrategyAuthorization');
  const savedEnv: Record<string, string | undefined> = {};
  const [A, B, C, RETIRED, E] = CORE_STRATEGIES.map((s) => s.id);

  beforeAll(async () => {
    for (const k of ['ARGUS_DB_PATH', 'PAPER_TRADING_ONLY']) savedEnv[k] = process.env[k];
    tmp = path.join(os.tmpdir(), `argus_lifecycle_baseline_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp; process.env.PAPER_TRADING_ONLY = 'true';
    ({ sqliteDb } = await import('../../db'));
    base = await import('./lifecycleBaseline');
    elig = await import('./StrategyEmissionEligibility');
    authz = await import('../QuantStrategyAuthorization');
    await elig.recordStrategyLifecycleTransition(RETIRED, 'RETIRED', 'pre-existing explicit retirement', null, 0);
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('dry run reports what would be recorded and writes nothing', async () => {
    const r = await base.recordUntestedBaselines({ reason: 'owner-authorized baseline dry run', actor: 'test', dryRun: true });
    expect(r.recorded.map((x) => x.strategyId).sort()).toEqual([A, B, C, E].sort());
    expect(r.skipped.map((x) => x.strategyId)).toEqual([RETIRED]);
    for (const id of [A, B, C, E]) expect(await elig.hasStrategyLifecycleRecord(id)).toBe(false);
  });

  it('records UNTESTED only for CORE strategies with no record, never overwrites RETIRED, and is idempotent', async () => {
    const r = await base.recordUntestedBaselines({ reason: 'owner-authorized baseline CORE 5', actor: 'test' });
    expect(r.recorded.map((x) => x.strategyId).sort()).toEqual([A, B, C, E].sort());
    for (const id of [A, B, C, E]) { expect(await elig.hasStrategyLifecycleRecord(id)).toBe(true); expect(await elig.getStrategyLifecycleStatus(id)).toBe('UNTESTED'); }
    expect(await elig.getStrategyLifecycleStatus(RETIRED)).toBe('RETIRED'); // untouched
    const again = await base.recordUntestedBaselines({ reason: 'owner-authorized baseline CORE 5', actor: 'test' });
    expect(again.recorded).toEqual([]);
    expect(again.skipped.length).toBe(CORE_STRATEGIES.length);
  });

  it('grants NO authority: a baselined strategy resolves to REQUIRES_CONSENSUS (never AUTHORIZED_QUANT_POLICY), RETIRED stays NOT_ELIGIBLE', async () => {
    const producer = (await import('../../config/quantDecisionPolicy')).quantDecisionPolicy.quantProducerAgents?.[0] ?? 'QuantEngine';
    const a = await authz.resolveQuantStrategyAuthorization({ origin: 'QUANT_STRATEGY', strategyId: A, agent: producer });
    expect(a.authority).toBe('REQUIRES_CONSENSUS');
    expect(a.authority).not.toBe('AUTHORIZED_QUANT_POLICY');
    const r = await authz.resolveQuantStrategyAuthorization({ origin: 'QUANT_STRATEGY', strategyId: RETIRED, agent: producer });
    expect(r.authority).toBe('NOT_ELIGIBLE');
  });

  it('refuses non-CORE ids, missing reason and missing actor', async () => {
    await expect(base.recordUntestedBaselines({ strategyIds: ['NOT_A_REAL_STRATEGY'], reason: 'long enough reason', actor: 'test' })).rejects.toMatchObject({ code: 'NOT_A_CORE_STRATEGY' });
    await expect(base.recordUntestedBaselines({ reason: 'short', actor: 'test' })).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
    await expect(base.recordUntestedBaselines({ reason: 'long enough reason', actor: '  ' })).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
  });

  it('only ever writes UNTESTED (static guard on the module source)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'lifecycleBaseline.ts'), 'utf8');
    const calls = src.match(/recordStrategyLifecycleTransition\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect(/VALIDATED|CHAMPION/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))).toBe(false);
  });
});
