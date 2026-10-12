/**
 * nextSessionCertExtras.ts — Phase 2 (2026-10-12) extensions for
 * `argus certify-next-session` (scripts/certifyNextSession.ts).
 *
 * Pure control-plane orchestration — NO quant math (Java 26 Engine Authority:
 * new indicator/strategy/signal calculations live in quant-core-java/, never TS).
 *
 * Three concerns:
 *
 * 1. buildRealStateSummary() — READ-ONLY snapshot of the real pre-market inputs:
 *    authorized strategies, the owner-requested PAPER allocation profile
 *    (config/paperAllocationProfile.json), existing positions (SELECT-only against
 *    the caller's DB handle), and the key trading-safety numbers as
 *    config/tradingSafety.json actually has them. Never writes, never seeds,
 *    never interprets, never weakens a threshold — it reports the numbers the
 *    release driver evaluated, plus the two inputs the driver does not already
 *    surface (allocation profile, open positions).
 *
 * 2. runMarketOpenCertify() — synthetic market-open session by spawning the
 *    EXISTING scripts/sim/marketOpen.ts --certify parent launcher (the same
 *    command package.json's test:certification runs) and parsing its stdout.
 *    Results are labeled SYNTHETIC_SEEDED / NON_ORGANIC /
 *    CERTIFICATION_FIXTURE_ONLY and are never presented as organic paper
 *    evidence. A PASS proves pipeline engineering capability (idea -> consensus
 *    -> risk -> OMS -> paper fill on synthetic data), not alpha. It never forces
 *    a strategy signal, a Chief/Risk approval, or a fill above the broker
 *    boundary — the sim's own HistoricalReplayBroker is the only "broker", and
 *    the sim runs in its own isolated tmp DBs, never the cert snapshot.
 *
 * 3. computeGoNoGo() — fail-closed verdict: GO only when the release driver
 *    says READY and the simulated session (when run) passed. A correct,
 *    explainable NO-GO is a valid result, never a bug.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Synthetic-fixture labeling (AGENTS.md: every synthetic calibration fixture is labeled). */
export const SYNTHETIC_FIXTURE_LABELS = [
  'SYNTHETIC_SEEDED',
  'NON_ORGANIC',
  'CERTIFICATION_FIXTURE_ONLY',
] as const;

const EVIDENCE_NOTE =
  'Classification: SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY. ' +
  'Test B seeds a synthetic calibration history (CalibrationHistorySeeder) by default — labeled SYNTHETIC_SEEDED. ' +
  'A PASS proves engineering capability (the idea->consensus->risk->OMS->paper-fill pipeline runs end to end on ' +
  'synthetic data), not organic empirically-validated alpha. Never counted as organic paper evidence.';

// ---------------------------------------------------------------------------
// 1. Real lifecycle-state summary (read-only)
// ---------------------------------------------------------------------------

export interface PositionRow {
  symbol: string;
  quantity: number;
  averagePrice: number | null;
  currentPrice: number | null;
  unrealizedPnL: number | null;
  brokerSource: string | null;
  currency: string | null;
}

export interface RealStateSummary {
  source: string;
  generatedAt: string;
  authorizedPaperQuantStrategies: number | null;
  quantVerdict: string | null;
  allocationProfile: {
    budget: number | null;
    source: string;
    note: string;
    error?: string;
  };
  positions: {
    count: number;
    rows: PositionRow[];
    truncated: boolean;
    error?: string;
  };
  tradingSafety: Record<string, number | null>;
  tradingSafetySource: string;
}

/** Key safety numbers, echoed from config — never re-derived or re-interpreted here. */
const SAFETY_KEYS = [
  'consensusApprovalThreshold',
  'minIndependentAgreeingAgents',
  'javaQuantVoteMinConfidence',
  'minQuantIndependentFamilies',
  'minQuantIndependentEffectiveCount',
];

const MAX_POSITION_ROWS = 50;

export function buildRealStateSummary(args: {
  productionState: { AUTHORIZED_PAPER_QUANT_STRATEGIES?: unknown; verdict?: unknown } | null;
  safetyConfig: Record<string, unknown>;
  db: { prepare(sql: string): { all(): unknown[] } };
  repoRoot: string;
}): RealStateSummary {
  const allocationPath = path.join(args.repoRoot, 'config', 'paperAllocationProfile.json');
  let budget: number | null = null;
  let allocError: string | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(allocationPath, 'utf8')) as { budget?: unknown };
    budget = typeof raw.budget === 'number' ? raw.budget : null;
    if (budget === null) allocError = 'budget field missing or not a number';
  } catch (e: unknown) {
    allocError = `unreadable: ${e instanceof Error ? e.message : String(e)}`;
  }

  let rows: PositionRow[] = [];
  let posError: string | undefined;
  try {
    const rawRows = args.db.prepare(
      'SELECT symbol, quantity, average_price AS averagePrice, current_price AS currentPrice, ' +
        'unrealized_pnl AS unrealizedPnL, broker_source AS brokerSource, currency FROM portfolio',
    ).all() as Array<Record<string, unknown>>;
    rows = rawRows.map((r) => ({
      symbol: String(r.symbol ?? ''),
      quantity: Number(r.quantity ?? 0),
      averagePrice: r.averagePrice == null ? null : Number(r.averagePrice),
      currentPrice: r.currentPrice == null ? null : Number(r.currentPrice),
      unrealizedPnL: r.unrealizedPnL == null ? null : Number(r.unrealizedPnL),
      brokerSource: r.brokerSource == null ? null : String(r.brokerSource),
      currency: r.currency == null ? null : String(r.currency),
    }));
  } catch (e: unknown) {
    posError = `probe failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  const tradingSafety: Record<string, number | null> = {};
  for (const k of SAFETY_KEYS) {
    const v = args.safetyConfig?.[k];
    tradingSafety[k] = typeof v === 'number' ? v : null;
  }

  const ps = args.productionState;
  return {
    source:
      'READ-ONLY: isolated production-DB snapshot (SELECT only) + config/*.json — no writes, no seeding, no promotion',
    generatedAt: new Date().toISOString(),
    authorizedPaperQuantStrategies:
      ps && typeof ps.AUTHORIZED_PAPER_QUANT_STRATEGIES === 'number'
        ? ps.AUTHORIZED_PAPER_QUANT_STRATEGIES
        : null,
    quantVerdict: ps && typeof ps.verdict === 'string' ? ps.verdict : null,
    allocationProfile: {
      budget,
      source: 'config/paperAllocationProfile.json',
      note:
        'Owner-requested PAPER allocation only (history in the file\'s $comment). ' +
        'A saved profile is not an activation; applying requires PAPER, paused trading and disabled Autobot.',
      ...(allocError ? { error: allocError } : {}),
    },
    positions: {
      count: rows.length,
      rows: rows.slice(0, MAX_POSITION_ROWS),
      truncated: rows.length > MAX_POSITION_ROWS,
      ...(posError ? { error: posError } : {}),
    },
    tradingSafety,
    tradingSafetySource:
      'config/tradingSafety.json (canonical; the release driver evaluates these — this summary only reports them)',
  };
}

// ---------------------------------------------------------------------------
// 2. Synthetic market-open session, reusing scripts/sim/marketOpen.ts --certify
// ---------------------------------------------------------------------------

export interface CertifySimTestRun {
  seed: number;
  certification: 'PASS' | 'FAIL';
  tradeObserved: boolean | null;
  calibrationSeeded?: boolean;
  detail: string;
}

export interface MarketOpenCertifyParse {
  testA: CertifySimTestRun[];
  testB: CertifySimTestRun[];
  overall: 'PASS' | 'FAIL';
  /** False when no OVERALL line and no test lines were found (unparseable output). */
  parsed: boolean;
}

const TEST_LINE_RE = /^TEST ([AB]) \([^)]*\) \[seed=(\d+)\]:\s+(PASS|FAIL) \((.*)\)\s*$/;
const OVERALL_RE = /^OVERALL: (PASS|FAIL)\b/;

function parseKvList(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of inner.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function toBoolOrNull(v: string | undefined): boolean | null {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * Parse the stdout of `scripts/sim/marketOpen.ts --certify`. Pure function,
 * unit-tested — the launcher may print TEST A/TEST B lines twice (once per run,
 * once in the summary); runs are deduped by (test, seed).
 */
export function parseMarketOpenCertifyOutput(stdout: string): MarketOpenCertifyParse {
  const runs = new Map<string, CertifySimTestRun>();
  const lines = stdout.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const m = TEST_LINE_RE.exec(line);
    if (m) {
      const which = m[1];
      const seed = Number(m[2]);
      const kv = parseKvList(m[4]);
      runs.set(`${which}:${seed}`, {
        seed,
        certification: m[3] as 'PASS' | 'FAIL',
        tradeObserved: toBoolOrNull(kv.tradeObserved),
        ...(kv.calibrationSeeded !== undefined
          ? { calibrationSeeded: kv.calibrationSeeded === 'true' }
          : {}),
        detail: m[4],
      });
    }
  }
  const testA: CertifySimTestRun[] = [];
  const testB: CertifySimTestRun[] = [];
  for (const [key, run] of runs) {
    if (key.startsWith('A:')) testA.push(run);
    else testB.push(run);
  }
  testA.sort((a, b) => a.seed - b.seed);
  testB.sort((a, b) => a.seed - b.seed);
  let overall: 'PASS' | 'FAIL' = 'FAIL';
  let parsed = false;
  for (const rawLine of lines) {
    const m = OVERALL_RE.exec(rawLine.trim());
    if (m) {
      overall = m[1] as 'PASS' | 'FAIL';
      parsed = true;
    }
  }
  if (!parsed && testA.length === 0 && testB.length === 0) {
    return { testA, testB, overall: 'FAIL', parsed: false };
  }
  return { testA, testB, overall, parsed };
}

export interface SimStageOptions {
  repoRoot: string;
  /** Clock speedMultiplier. Default 400 — the same speed package.json test:certification uses. */
  speed?: number;
  /** Fail-closed ceiling. Default 20 min — a full --certify run at speed 400 takes a few wall-clock minutes. */
  timeoutMs?: number;
}

export interface SimStageResult {
  classification: readonly string[];
  command: string;
  speed: number;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
  error: string | null;
  parsed: MarketOpenCertifyParse;
  pass: boolean;
  summary: string;
  evidenceNote: string;
  rawTail: string[];
}

/**
 * Run the synthetic session. Never throws on sim failure — every failure mode
 * (timeout, launch error, unparseable output, FAIL) is returned as a failed
 * stage so the caller can fail the verdict closed (NO_GO).
 */
export async function runMarketOpenCertify(opts: SimStageOptions): Promise<SimStageResult> {
  const speed = opts.speed ?? 400;
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
  const command = `scripts/sim/marketOpen.ts --certify --speed=${speed}`;
  const started = Date.now();
  const base: SimStageResult = {
    classification: SYNTHETIC_FIXTURE_LABELS,
    command,
    speed,
    durationMs: 0,
    timedOut: false,
    exitCode: null,
    error: null,
    parsed: { testA: [], testB: [], overall: 'FAIL', parsed: false },
    pass: false,
    summary: 'not completed',
    evidenceNote: EVIDENCE_NOTE,
    rawTail: [],
  };
  try {
    const tsxCli = path.join(opts.repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const simScript = path.join(opts.repoRoot, 'scripts', 'sim', 'marketOpen.ts');
    if (!fs.existsSync(tsxCli) || !fs.existsSync(simScript)) {
      base.error = `sim infrastructure missing (tsxCli=${fs.existsSync(tsxCli)}, simScript=${fs.existsSync(simScript)})`;
      base.durationMs = Date.now() - started;
      base.summary = `stage error: ${base.error}`;
      return base;
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    // The sim launcher computes its own isolated tmp DBs per child (buildChildEnv)
    // and never touches the cert snapshot — but never inherit the snapshot path
    // anyway; the sim must be unambiguous about which DB it uses.
    delete env.ARGUS_DB_PATH;
    env.SYNTHETIC_SIMULATION = 'true';
    env.PAPER_TRADING_ONLY = 'true';
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const exitCode = await new Promise<number | null>((resolve) => {
      let settled = false;
      const done = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      };
      const child = spawn(
        process.execPath,
        ['--use-system-ca', tsxCli, simScript, '--certify', `--speed=${speed}`],
        { cwd: opts.repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* best effort */
        }
        done(null);
      }, timeoutMs);
      child.stdout?.on('data', (d) => {
        stdout += String(d);
      });
      child.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      child.on('error', () => done(null));
      child.on('exit', (code) => done(code));
    });
    base.durationMs = Date.now() - started;
    base.timedOut = timedOut;
    base.exitCode = exitCode;
    if (timedOut) {
      base.error = `sim stage timed out after ${timeoutMs}ms (fail-closed)`;
    } else if (exitCode === null) {
      base.error = `sim child failed to launch or was killed (stderr tail: ${stderr.slice(-500)})`;
    }
    base.parsed = parseMarketOpenCertifyOutput(stdout);
    const aSummary = base.parsed.testA.map((r) => `seed=${r.seed}:${r.certification}`).join(', ') || 'none';
    const bSummary = base.parsed.testB.map((r) => `seed=${r.seed}:${r.certification}`).join(', ') || 'none';
    base.summary = `Test A [${aSummary}] | Test B [${bSummary}] | OVERALL ${base.parsed.overall}${timedOut ? ' (TIMED OUT)' : ''}`;
    base.rawTail = stdout.split('\n').slice(-20);
    base.pass = !timedOut && exitCode === 0 && base.error === null && base.parsed.overall === 'PASS';
    return base;
  } catch (e: unknown) {
    base.durationMs = Date.now() - started;
    base.error = `sim stage internal error: ${e instanceof Error ? e.message : String(e)}`;
    base.summary = `stage error: ${base.error}`;
    return base;
  }
}

// ---------------------------------------------------------------------------
// 3. Fail-closed GO / NO-GO verdict
// ---------------------------------------------------------------------------

export type DriverOverallStatus = 'READY' | 'READY_WITH_CONDITIONS' | 'NO_GO';
export type GoNoGoVerdict = 'GO' | 'NO-GO';

export interface GoNoGoInput {
  driverOverallStatus: DriverOverallStatus;
  driverBlockingChecks: string[];
  simStage: { ran: boolean; pass: boolean; summary: string };
}

/**
 * GO requires driver READY and (when the sim stage ran) a passing sim.
 * READY_WITH_CONDITIONS and NO_GO both map to NO-GO — fail closed. A correct,
 * explainable NO-GO is a valid certification result.
 */
export function computeGoNoGo(input: GoNoGoInput): { goNoGo: GoNoGoVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const driverReady = input.driverOverallStatus === 'READY';
  if (!driverReady) {
    const blocking =
      input.driverBlockingChecks.length > 0
        ? `; blocking checks: ${input.driverBlockingChecks.join(', ')}`
        : '';
    reasons.push(
      `release certification OVERALL_STATUS=${input.driverOverallStatus}${blocking} (a partial probe can never report READY)`,
    );
  }
  if (input.simStage.ran && !input.simStage.pass) {
    reasons.push(`simulated market-open session FAILED (${input.simStage.summary}) — see the simulatedSession evidence`);
  }
  const goNoGo: GoNoGoVerdict =
    driverReady && (!input.simStage.ran || input.simStage.pass) ? 'GO' : 'NO-GO';
  if (goNoGo === 'GO') {
    reasons.push(
      input.simStage.ran
        ? `all release checks PASS; simulated market-open session PASS (${input.simStage.summary})`
        : 'all release checks PASS; simulated session not run in this invocation (pass --with-sim to include it)',
    );
  }
  return { goNoGo, reasons };
}
