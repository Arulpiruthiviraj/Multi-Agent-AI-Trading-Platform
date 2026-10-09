// LABEL: ARCHITECTURE_INVARIANT - proves via real resolver+policy composition and code-shape locks that a LIVE environment can never grant quant authority. Fail-closed guarantee, not a trading outcome.
/**
 * Part-30 spine-level LIVE authority tests (Workstream F, 2026-10-08).
 *
 * Proves, through the REAL production chain (not unit mocks), that the
 * AI-independent quant path can never authorize in a LIVE environment:
 *
 *   ChiefTrader.router -> resolveQuantStrategyAuthorization -> evaluateQuantExecutionPolicy
 *
 * With the paper-only env lock disengaged (PAPER_TRADING_ONLY != 'true'), the resolver
 * is the single authority-granting module in production and it checks the lock BEFORE
 * any grant site; the policy refuses anything that is not AUTHORIZED_QUANT_POLICY as
 * its FIRST check. This suite proves the composition holds end to end and locks the
 * code shape that makes it true:
 *   - exactly one production module constructs an AUTHORIZED_QUANT_POLICY grant,
 *   - the lock check precedes every grant site in that module,
 *   - exactly one production call site of evaluateQuantExecutionPolicy exists.
 *
 * Deliberately does NOT duplicate:
 *   - QuantStrategyAuthorization.test.ts (authorization-layer unit tests, incl. its own
 *     LIVE/NOT_ELIGIBLE case) and the sibling workstream's authorization-layer
 *     ACTIVE_EXPLORATION+LIVE tests,
 *   - QuantExecutionPolicy.test.ts (policy unit tests incl. 'rejects when authority is
 *     not AUTHORIZED_QUANT_POLICY' with a hand-built fixture).
 * The composition test below uses the resolver's REAL output in a LIVE-shaped
 * environment, which neither unit suite covers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_STRATEGIES } from './strategies/StrategyEngine';
import type { QuantStrategyAuthorization } from './QuantStrategyAuthorization';

const STRATEGY_ID = CORE_STRATEGIES[0].id;
const ROOT = join(process.cwd());

function read(p: string): string {
  return readFileSync(join(ROOT, p), 'utf8');
}

/** Strip line and block comments so doc comments naming a concept don't count as code. */
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

// A fully-valid quant signal: every policy check WOULD pass with a genuinely
// authorized authority (same shape as QuantExecutionPolicy.test.ts's approving fixture).
// The only thing that can refuse it in the test below is the authority itself.
function validIdea() {
  const evaluation = {
    strategy: STRATEGY_ID,
    side: 'BUY',
    setupScore: 85,
    confidence: 0.8,
    triggerMet: true,
    conditionsMet: ['breakout'],
    conditionsFailed: [],
    contradictions: [],
    invalidationConditions: ['close back below breakout level'],
    stop: { price: 95, basis: 'swing low' },
    target: { price: 110, basis: 'measured move' },
    applicableRegimes: ['BULLISH_TREND'],
  };
  return {
    traceId: 'trace_live_auth_1',
    symbol: 'AAPL',
    side: 'BUY',
    confidence: 0.8,
    reasoning: 'test breakout',
    agent: 'QuantEngine',
    currentPrice: 100,
    strategyId: STRATEGY_ID,
    origin: 'QUANT_STRATEGY',
    quantDetail: {
      strategyEvaluation: evaluation,
      regime: { regime: 'BULLISH_TREND' },
      internalEnsemble: { rawSide: 'BUY', sideMismatch: false, qualifiesAsIndependent: true },
      dataQuality: { tradeBlocked: false, blockReason: null },
    },
  };
}

const sufficientCalibration = async () => ({ sufficient: true, sampleSize: 120 });

describe('Part-30: LIVE environment — the real resolver/policy chain refuses quant authority', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let authz: typeof import('./QuantStrategyAuthorization');
  let policy: typeof import('./QuantExecutionPolicy');
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['ARGUS_DB_PATH', 'PAPER_TRADING_ONLY']) savedEnv[k] = process.env[k];
    tmpDbPath = path.join(os.tmpdir(), `argus_quant_live_auth_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    // LIVE shape: the paper-only env lock is DISENGAGED.
    process.env.PAPER_TRADING_ONLY = '';
    // Dynamic imports AFTER ARGUS_DB_PATH is set (same proven pattern as
    // QuantStrategyAuthorization.test.ts): the db module migrates on first import.
    ({ sqliteDb } = await import('../db'));
    authz = await import('./QuantStrategyAuthorization');
    policy = await import('./QuantExecutionPolicy');
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

  it('with the paper-only lock disengaged, the resolver mints no quant authority and the real policy refuses a fully-valid signal', async () => {
    const authorization = await authz.resolveQuantStrategyAuthorization({
      origin: 'QUANT_STRATEGY',
      strategyId: STRATEGY_ID,
      agent: 'QuantEngine',
    });
    // The resolver's own LIVE output (asserted in full by the authorization-layer
    // suite; here it is only the honest input to the policy): never the grant.
    expect(authorization.authority).not.toBe('AUTHORIZED_QUANT_POLICY');

    const decision = await policy.evaluateQuantExecutionPolicy(
      validIdea() as any,
      authorization,
      { calibrationLookup: sufficientCalibration },
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasonCode).toBe('QUANT_AUTHORITY_INVALID');
    // The authority check is the policy's FIRST required check: the refusal is from
    // authority, provably not from some other invalidity in the idea.
    expect(decision.checks[0].id).toBe('AUTHORITY_VALID');
    expect(decision.checks[0].passed).toBe(false);
    expect(decision.decisionPolicy).toBe('QUANT_EXECUTION');
  });

  it('the same idea with a genuinely-authorized authority would pass the authority check (the refusal is authority-specific)', async () => {
    const authorization = {
      authority: 'AUTHORIZED_QUANT_POLICY',
      reason: 'STRATEGY_VALIDATED',
      origin: 'QUANT_STRATEGY',
      strategyId: STRATEGY_ID,
      lifecycleStatus: 'VALIDATED',
      producerAgent: 'QuantEngine',
      paperOnlyEnforced: true,
      checkedAt: new Date().toISOString(),
    } as QuantStrategyAuthorization;
    const decision = await policy.evaluateQuantExecutionPolicy(
      validIdea() as any,
      authorization,
      { calibrationLookup: sufficientCalibration },
    );
    const authorityCheck = decision.checks.find((c) => c.id === 'AUTHORITY_VALID');
    expect(authorityCheck?.passed).toBe(true);
  });
});

describe('Part-30: no production code path can grant LIVE quant authority', () => {
  it('exactly one production module constructs an AUTHORIZED_QUANT_POLICY grant: the resolver', () => {
    const hits: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '.venv' || name === 'archive') continue;
        const p = join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) out.push(...walk(p));
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
      }
      return out;
    };
    const roots = [join(ROOT, 'src'), join(ROOT, 'scripts')];
    if (fs.existsSync(join(ROOT, 'server.ts'))) roots.push(join(ROOT, 'server.ts'));
    for (const r of roots) {
      const files = fs.statSync(r).isDirectory() ? walk(r) : [r];
      for (const f of files) {
        const code = stripComments(readFileSync(f, 'utf8'));
        // A grant site: an object literal assigning the AUTHORIZED_QUANT_POLICY value.
        // Guard sites (=== comparisons) and type unions do not grant and are not matched.
        if (/authority\s*:\s*['"]AUTHORIZED_QUANT_POLICY['"]/.test(code)) {
          hits.push(path.relative(ROOT, f).split(path.sep).join('/'));
        }
      }
    }
    expect(hits).toEqual(['src/server/quant/QuantStrategyAuthorization.ts']);
  });

  it('the resolver checks the paper-only env lock BEFORE any authority grant site', () => {
    const code = stripComments(read('src/server/quant/QuantStrategyAuthorization.ts'));
    const lockIdx = code.indexOf('!common.paperOnlyEnforced');
    expect(lockIdx, 'expected the paper-only lock check in resolveQuantStrategyAuthorization').toBeGreaterThan(-1);
    const grants: number[] = [];
    const re = /authority\s*:\s*['"]AUTHORIZED_QUANT_POLICY['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) grants.push(m.index);
    expect(grants.length, 'expected exactly the two known grant sites (VALIDATED, CHAMPION)').toBe(2);
    for (const g of grants) {
      expect(g).toBeGreaterThan(lockIdx);
    }
  });

  it('exactly one production call site of evaluateQuantExecutionPolicy exists (ChiefTrader router)', () => {
    const hits: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '.venv' || name === 'archive') continue;
        const p = join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) out.push(...walk(p));
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
      }
      return out;
    };
    for (const f of walk(join(ROOT, 'src'))) {
      const code = stripComments(readFileSync(f, 'utf8'));
      if (/evaluateQuantExecutionPolicy\s*\(/.test(code)) {
        hits.push(path.relative(ROOT, f).split(path.sep).join('/'));
      }
    }
    // The defining module (QuantExecutionPolicy.ts) trivially contains the name via its own
    // export — the invariant is about CALL sites, so exclude the definition file.
    const callSites = hits.filter((h) => h !== 'src/server/quant/QuantExecutionPolicy.ts');
    expect(callSites).toEqual(['src/server/services/ChiefTraderAgent.ts']);
    const router = stripComments(read('src/server/services/ChiefTraderAgent.ts'));
    expect(router.match(/evaluateQuantExecutionPolicy\s*\(/g)?.length).toBe(1);
  });
});
