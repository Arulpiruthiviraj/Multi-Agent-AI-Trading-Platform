#!/usr/bin/env node
/**
 * Argus CLI — HTTP client + optional process lifecycle for headless engine.
 * MUST NOT import RiskEngine, OMS, BrokerManager, or TradingEngine.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearEnginePid,
  isEngineProcessRunning,
  isPidLikelyArgusProcess,
  readEnginePid,
  writeEnginePid,
} from '../src/server/app/enginePid';
import {
  clearWatchdogPid,
  isPidAlive,
  isWatchdogProcessRunning,
  readWatchdogPid,
  writeWatchdogPid,
} from '../src/server/app/watchdogPid';
import {
  buildCliAuthHeaders,
  clearSessionFile,
  collectSetCookieHeaders,
  defaultSessionFilePath,
  EXIT_AUTH,
  parseSessionCookieFromSetCookie,
  resolveCliCredentials,
  unauthorizedMessage,
  writeSessionCookie,
} from './cli/cliSession';

/** Default API base; may be overridden per-invocation by --api-url= (see dispatch). */
let BASE = process.env.ARGUS_API_URL || 'http://127.0.0.1:3000';

/** Resolve the effective API base URL (flag > env > default). Exported for tests. */
export function apiBase(): string {
  return BASE;
}

/** Apply the --api-url= global flag. Called once by the dispatch block. */
export function setApiBaseOverride(url: string): void {
  BASE = url;
}

/**
 * Global --json flag: entity commands (positions, orders, trades, brokers,
 * agents, events, logs) print human-readable tables by default and raw JSON
 * with --json — the kubectl/gh convention: humans get tables, scripts get JSON.
 */
let JSON_MODE = false;

/** Whether --json was passed. Exported for tests and command implementations. */
export function isJsonOutput(): boolean {
  return JSON_MODE;
}

/** Apply the global --json flag. Called once by the dispatch block. */
export function setJsonOutput(on: boolean): void {
  JSON_MODE = on;
}

/** Print raw JSON (respects --json contract explicitly). */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** One column of a human-readable table. pick() must never throw. */
export interface TableColumn {
  header: string;
  pick: (row: any) => string;
}

function safeCell(row: any, pick: (row: any) => string): string {
  try {
    const v = pick(row);
    return v === null || v === undefined ? '-' : String(v);
  } catch {
    return '-';
  }
}

/**
 * Print rows as an aligned human-readable table (stdout).
 * Falls back to "(no rows)" for empty input. Long values are truncated so
 * one wide cell can't blow out the layout.
 */
export function printTable(rows: any[], columns: TableColumn[]): void {
  if (!rows || rows.length === 0) {
    console.log('(no rows)');
    return;
  }
  const maxWidth = 48;
  const cells = rows.map((r) =>
    columns.map((c) => {
      const s = safeCell(r, c.pick);
      return s.length > maxWidth ? s.slice(0, maxWidth - 1) + '…' : s;
    }),
  );
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...cells.map((row) => row[i].length)),
  );
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ');
  console.log(line(columns.map((c) => c.header)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const row of cells) console.log(line(row));
}

/** Pick the first present field from a list of candidate names. */
export function field(row: any, ...names: string[]): string {
  for (const n of names) {
    const v = row?.[n];
    if (v !== null && v !== undefined && v !== '') return String(v);
  }
  return '-';
}
/** Repo root even when cwd is elsewhere (./argus from another directory). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_PATH = process.env.ARGUS_CLI_SESSION_FILE || defaultSessionFilePath(ROOT);

class AuthRequiredError extends Error {
  readonly exitCode = EXIT_AUTH;
  constructor() {
    super(unauthorizedMessage());
    this.name = 'AuthRequiredError';
  }
}

/** POSIX convention: exit 2 = command-line usage error (bad/missing args). */
export const EXIT_USAGE = 2;

export class UsageError extends Error {
  readonly exitCode = EXIT_USAGE;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Throw a usage error: printed to stderr with exit code 2 by the dispatch
 * handler. Prefer this over `console.log('Usage: ...'); return;` (which
 * misleadingly exits 0) for missing/invalid arguments.
 */
export function usageError(message: string): never {
  throw new UsageError(message);
}

function cliAuthHeaders(): Record<string, string> {
  return buildCliAuthHeaders({ sessionPath: SESSION_PATH });
}

export async function fetchJson(path: string, init?: RequestInit) {
  // CLI/control-plane hardening (2026-09-23, real bug found and reproduced live): 10s was too
  // short for genuinely-healthy-but-momentarily-busy aggregation endpoints (status/health, which
  // fan out over pipeline agents, IBKR paths, and up to 10 AI-provider health checks) - a real
  // `status` call against a live, correctly-running engine timed out repeatedly with the
  // uninformative "The operation was aborted due to timeout", indistinguishable from a genuine
  // hang. Raised to a still-bounded, still-overridable default that comfortably covers that real,
  // observed case without becoming an unbounded wait - this is a plain HTTP client timeout guard
  // against one already-alive server, not the ecosystem-level boot-readiness state model (that
  // false-negative class of bug is fixed separately, in argus.sh/argus-ecosystem-status.ts's own
  // STARTING/FAILED classification - simply raising a number is not treated as a fix there).
  const timeoutMs = Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 20_000);
  const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  let requestId: string | null = null;
  let res: Response;
  let text: string;
  try {
  res = await fetch(`${BASE}${path}`, {
    ...init,
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...cliAuthHeaders(),
      ...(init?.headers || {}),
    },
  });
  requestId = res.headers.get('x-request-id');
  text = await res.text();
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    const reason = signal.aborted ? 'REQUEST_ABORTED_OR_TIMED_OUT'
      : code === 'ECONNREFUSED' ? 'ENGINE_UNREACHABLE' : 'TRANSPORT_FAILED';
    throw new Error(`${reason}: ${init?.method ?? 'GET'} ${path.split('?')[0]} after ${Date.now() - started}ms`
      + (requestId ? ` (requestId=${requestId})` : '')
      + '. No server completion was confirmed; this does not establish broker or order failure.',
      { cause: { code: signal.aborted ? undefined : code } });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (res.status === 401 || res.status === 403) {
    throw new AuthRequiredError();
  }
  if (!res.ok) {
    throw new Error(typeof body === 'object' && body && 'error' in (body as object)
      ? String((body as { error: string }).error)
      : `HTTP ${res.status}`);
  }
  return body;
}

/**
 * Real bug found and fixed (2026-09-22, CLI hardening pass): commands that read a positional
 * argument via a raw `process.argv[N]` index (e.g. `trade-plan [date]`, `ranking [SYMBOL]`) had no
 * way to tell a real positional value apart from a bare `--flag` token typed out of habit - every
 * command in this file already always prints JSON, so `--json` is meaningless to them, but typing it
 * anyway (as documented for `health`) got silently consumed as the positional value instead of being
 * ignored. Reproduced live: `argus trade-plan --json` returned `planDate: "--json"` instead of
 * defaulting to today. `cliArgs()` is `process.argv.slice(3)` with bare `--*` tokens filtered out;
 * every positional-index command below reads from it instead of `process.argv` directly. The
 * `--key=value` style commands (`--reason=`, `--limit=`, etc., via `.find(a => a.startsWith(...))`)
 * were never affected by this bug and are unchanged.
 */
function cliArgs(): string[] {
  return process.argv.slice(3).filter((a) => !a.startsWith('--'));
}

/**
 * Real, live-reproduced defect (2026-08-25 readiness audit): this previously checked only
 * `h.ok`, which trivially returns true if ANY process - old or new - already answers on the
 * configured port. Observed directly: `restart` failed to signal a stale/mismatched-PID-file
 * engine (the PID-reuse guard in stopEngine() correctly refused to kill an unrelated process),
 * then `startEngine()` spawned a brand-new child that never actually took over the port - yet
 * the CLI reported "Engine started" with a fresh PID because the OLD process kept answering
 * /health successfully.
 *
 * Note this does NOT compare against the spawned `child.pid` directly: in dev mode (tsx) the
 * spawned process is only a CLI wrapper (`tsx/dist/cli.mjs`), which itself forks a separate child
 * to actually run scripts/argus-engine.ts and bind the port - confirmed live (two distinct
 * node.exe processes, wrapper -> real engine, different PIDs). Comparing the real /health pid
 * against `child.pid` would therefore falsely fail on every normal dev-mode start. Instead the
 * caller passes `notPid`: the pid that was already answering *before* this start attempt (if
 * any). A genuinely new engine will report a pid different from that; the stale-process
 * collision this fix targets reports the exact same `notPid` back.
 */
/**
 * Full "is everything actually fine" report - runtime health + broker connection + AI provider
 * pool + Kronos/Chronos + QuantCoreBridge, in one place. Shared by `argus-cli health` and a
 * successful `argus-cli start` (so starting no longer requires a manual follow-up `health` call to
 * see the same picture this session already needed to reconstruct by hand).
 */
/**
 * Real bug found and fixed (2026-09-22, CLI hardening pass): a caller asking for `--json` (both
 * scripts/cli/common.sh's argus_cmd_health() and its PowerShell port, argus.ps1, branch on exactly
 * this flag expecting pure-JSON output) got the SAME combined JSON+human-readable-sections report
 * either way, because this function never checked for the flag at all - `JSON.parse()`-ing the
 * result then threw on the trailing "QuantCoreBridge: ..."/"Companion services: ..." lines,
 * silently breaking the pretty-printed `argus health` path in both shells (reproduced live in both
 * before this fix). `jsonOnly` restores the intended distinction: the health() command below now
 * passes it through when `--json` is present; the no-args call from a successful start/restart
 * (which always wants the full human-readable picture) is unaffected by default.
 */
async function printFullHealthReport(jsonOnly = false): Promise<void> {
  const health = await fetchJson('/api/v2/runtime/health');
  if (jsonOnly) {
    console.log(JSON.stringify(health, null, 2));
    return;
  }
  console.log(JSON.stringify(health, null, 2));
  const qc = await fetchJson('/api/v2/quant-core/health') as { enabled: boolean; connected: boolean; detail?: string };
  const label = !qc.enabled ? 'DISABLED' : qc.connected ? 'CONNECTED' : 'DISCONNECTED';
  console.log(`QuantCoreBridge: ${label}${qc.detail ? ` (${qc.detail})` : ''}`);

  // Real gap closed (2026-09-07): the durable per-component reason (StartupHealthRegistry.ts's
  // collectStartupHealth() - status/rootCause/impact/fix for OpenAlice/Chronos/Ollama/QuantSignalAgent/
  // Alpaca/AIRouter) previously only existed behind a raw HTTP route
  // (GET /api/v2/system/startup-health) with no CLI surface - an operator asking "why isn't Ollama/
  // Chronos connected" had to already know that route and hand-craft an authenticated request. Folding
  // it into the SAME report `argus-cli health` and a successful `start`/`restart` already print means
  // every companion service's explicit reason is visible by default, not just IBKR/broker/AI-provider
  // pool (which were already in /api/v2/runtime/health above). This is on-demand/always-fresh (each
  // service is re-probed on every call) - unlike ServerLogBuffer's 500-line console-log ring, it is not
  // subject to early-boot log lines being evicted by later log volume before an operator can look.
  try {
    const startup = await fetchJson('/api/v2/system/startup-health') as {
      services: Array<{ service: string; status: string; rootCause: string | null; impact: string; fix: string }>;
    };
    console.log('Companion services:');
    for (const s of startup.services) {
      const reason = s.rootCause ? ` - ${s.rootCause}` : '';
      console.log(`  ${s.service}: ${s.status}${reason}`);
      if (s.status === 'FAILED' || s.status === 'DEGRADED') {
        console.log(`    impact: ${s.impact}`);
        console.log(`    fix: ${s.fix}`);
      }
    }
  } catch (e: any) {
    console.log(`Companion services: unavailable (${e?.message || e})`);
  }
}

async function waitForHealth(timeoutMs = 60_000, notPid?: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const h = await fetchJson('/api/v2/runtime/health') as { ok?: boolean; health?: { pid?: number } };
      if (h.ok && (notPid === undefined || h.health?.pid !== notPid)) return true;
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Real defect fixed (2026-09-12, live-reproduced double-engine incident): a probe result of
 * "the fetch threw" was previously treated as unconditional proof that nothing is listening -
 * indistinguishable from a genuine ECONNREFUSED (port closed) and a mere TimeoutError (the server
 * is alive but momentarily slow/busy, confirmed live via this codebase's own recurring
 * heartbeat-staleness pattern in data/logs/watchdog.log). waitForHealthGone() was concluding "the
 * old process is confirmed gone" from a slow-but-alive server, clearing the pid file and letting
 * startEngine() spawn a second real engine while the first was still actually holding port 3000 -
 * the second became an untracked, unreachable-via-HTTP zombie (fully live: real IBKR/Ollama/broker
 * connections) that only stopped when it later crashed on its own. `probeHealth()` now returns a
 * real three-way result so callers can tell "confirmed nothing listening" apart from "unknown -
 * treat as still possibly alive," matching Node's own documented fetch failure shapes:
 * ECONNREFUSED (TypeError, cause.code === 'ECONNREFUSED') vs a timeout (TimeoutError).
 */
export type HealthProbeResult =
  | { kind: 'answered'; pid: number | undefined }
  | { kind: 'refused' }
  | { kind: 'unknown' };

export async function probeHealth(): Promise<HealthProbeResult> {
  try {
    const h = await fetchJson('/api/v2/runtime/health') as { ok?: boolean; health?: { pid?: number } };
    return { kind: 'answered', pid: h.ok ? h.health?.pid : undefined };
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e;
    const cause = (e as { cause?: { code?: string } } | undefined)?.cause;
    if (cause?.code === 'ECONNREFUSED') return { kind: 'refused' };
    // Any other failure (TimeoutError, ECONNRESET mid-response, etc.) is NOT proof the process is
    // gone - it may just be slow or momentarily busy. Never conflate "I couldn't confirm" with
    // "confirmed absent".
    return { kind: 'unknown' };
  }
}

/**
 * DEF-26 support: poll until nothing answers /health, confirming a graceful shutdown request
 * actually completed rather than assuming a fixed delay was long enough (the previous restart()
 * used a blind 1500ms setTimeout with no confirmation at all). Only a genuine ECONNREFUSED counts
 * as "gone" - an ambiguous/timeout result keeps polling rather than declaring victory early (see
 * probeHealth()'s doc comment for the live incident this closes).
 */
export async function waitForHealthGone(timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await probeHealth();
    if (result.kind === 'refused') return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * CLI/control-plane hardening (2026-09-23), headless/engine-daemon counterpart to argus.sh's own
 * `wait-ready` action. Blocks until the API genuinely answers /health, or a real bounded timeout
 * elapses - never treats "still starting" as a failure, and never exits nonzero purely because
 * boot is slow. `probeHealth()`'s existing three-way result (answered/refused/unknown) already
 * distinguishes a real problem from "can't confirm yet" - this just polls it until "answered" or
 * time runs out, with periodic progress so a caller watching this command sees it actively working.
 */
export async function waitForHealthReady(timeoutMs = 240_000, onProgress?: (waitedMs: number) => void): Promise<boolean> {
  const start = Date.now();
  let lastReport = 0;
  while (Date.now() - start < timeoutMs) {
    const result = await probeHealth();
    if (result.kind === 'answered') return true;
    const waited = Date.now() - start;
    if (onProgress && waited - lastReport >= 15_000) {
      onProgress(waited);
      lastReport = waited;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

/** Best-effort read of whatever pid is currently answering /health, before a start/restart.
 *  Returns undefined both when nothing answers AND when the probe was merely inconclusive - callers
 *  that need to distinguish those two cases (see startEngine()'s pre-spawn guard) should call
 *  probeHealth() directly instead. */
async function currentlyAnsweringPid(): Promise<number | undefined> {
  const result = await probeHealth();
  return result.kind === 'answered' ? result.pid : undefined;
}

export function parseFlags(argv: string[]) {
  return {
    headless: argv.includes('--headless') || argv.includes('-H'),
    prod: argv.includes('--prod'),
    dev: argv.includes('--dev'),
    // 2026-09-15: lets `start` chain the same, already-safe resumeTrading() operator-resume path
    // (see that function's own doc comment) onto a successful boot, instead of requiring a
    // separate `argus-cli resume` call every morning. Does NOT bypass anything resumeTrading()
    // itself already checks (reconciliation/gates still apply server-side) - this flag only
    // decides whether `start` calls it at all. Never implied by --prod/--dev/--headless.
    enableTrading: argv.includes('--enable-trading'),
    // 2026-10-05: lets `start` skip the watchdog auto-start (which is otherwise on by default)
    // for maintenance/debug sessions where an unsupervised engine is intentional.
    noWatchdog: argv.includes('--no-watchdog'),
  };
}

export function resumeReasonFromArgv(argv: string[], fallback: string): string {
  const reasonArg = argv.find((a) => a.startsWith('--reason='));
  return reasonArg ? reasonArg.slice('--reason='.length) : fallback;
}

/**
 * The real tradingState resume path (POST /api/v1/system/resume), distinct from /autobot/toggle
 * (which only gates new BUY idea generation, not the tradingState machine itself). Shared by the
 * `resume` command and `start --enable-trading` so there is exactly one place this call is made,
 * not two copies that could drift. Still fully operator-controlled: this function is only ever
 * invoked because a human ran `argus-cli resume` or explicitly passed `--enable-trading` - never
 * implicitly, never on a timer inside this file. The server side still applies every existing
 * safety check (reconciliation, restart safety, etc.) on this same path regardless of caller.
 */
async function resumeTrading(reason: string): Promise<unknown> {
  return fetchJson('/api/v1/system/resume', {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

function parseReplayArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--capital' && argv[i + 1]) out.capital = argv[++i];
    else if (a === '--start' && argv[i + 1]) out.start = argv[++i];
    else if (a === '--end' && argv[i + 1]) out.end = argv[++i];
    else if (a === '--universe' && argv[i + 1]) out.universe = argv[++i];
    else if (a === '--symbols' && argv[i + 1]) out.symbols = argv[++i];
    else if (a === '--provider' && argv[i + 1]) out.provider = argv[++i];
    else if (a === '--engine' && argv[i + 1]) out.engine = argv[++i];
    else if (a === '--target' && argv[i + 1]) out.target = argv[++i];
    else if (!a.startsWith('--') && !out.runId) out.runId = a;
  }
  return out;
}

/**
 * `--engine java` does NOT submit to the real Historical Evaluation API
 * (/api/v2/historical-evaluations, FullArgusReplayEngine — ChiefTrader/RiskEngine/PositionSizing/
 * OMS/HistoricalReplayBroker). It spawns the standalone quant-core-java backtest CLI as a local
 * subprocess instead — a genuinely DIFFERENT, simpler demonstration backtest (RsiThresholdStrategy
 * on raw historical bars from data/argus.db, see quant-core-java's own RsiThresholdStrategy.java
 * header comment) with no ChiefTrader/RiskEngine/OMS involvement at all. This banner exists so
 * that difference is never missed. Auto-builds the jar via `mvn -B package -DskipTests` on first
 * use if it is not already present.
 */
async function runJavaReplay(args: Record<string, string>): Promise<void> {
  console.log(
    '=====================================================================\n' +
    'NOTE: --engine java does NOT run real Argus Historical Evaluation.\n' +
    'It runs quant-core-java\'s standalone demonstration backtest engine\n' +
    '(RsiThresholdStrategy over real historical bars) with ZERO ChiefTrader\n' +
    '/ RiskEngine / OMS / HistoricalReplayBroker involvement. Use the\n' +
    'default (node) engine for anything that needs to reflect the real,\n' +
    'protected Argus decision spine.\n' +
    '=====================================================================',
  );
  const moduleDir = join(ROOT, 'quant-core-java');
  const jarPath = join(moduleDir, 'target', 'quant-core-java-0.0.1-SNAPSHOT.jar');
  if (!existsSync(jarPath)) {
    console.log('[replay --engine java] Jar not found — building via `mvn -B package -DskipTests` (first use only)...');
    const build = await new Promise<number>((resolve) => {
      const child = spawn('mvn', ['-B', 'package', '-DskipTests'], { cwd: moduleDir, stdio: 'inherit', shell: true });
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });
    if (build !== 0 || !existsSync(jarPath)) {
      throw new Error(`quant-core-java build failed or jar still missing at ${jarPath}. Run "mvn -B package -DskipTests" in quant-core-java/ manually to see the error.`);
    }
  }

  const cliArgs = ['-jar', jarPath];
  if (args.start) cliArgs.push('--start', args.start);
  if (args.end) cliArgs.push('--end', args.end);
  if (args.symbols) cliArgs.push('--symbols', args.symbols);
  if (args.target) cliArgs.push('--target', args.target);
  if (args.capital) cliArgs.push('--cash', args.capital);
  cliArgs.push('--db', join(ROOT, 'data', 'argus.db'));

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn('java', cliArgs, { cwd: moduleDir, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (e) => {
      console.error(`Failed to launch java: ${e.message}`);
      resolve(1);
    });
  });
  if (exitCode !== 0) process.exit(exitCode);
}

/**
 * Pure - no I/O, no spawn. The exact `node` argv the engine is launched with, isolated here so
 * this one decision is directly unit-testable without mocking child_process or the CLI's own
 * dispatch loop.
 *
 * Silent-engine-death investigation (2026-09-04): the --dev (non-prod) path used to spawn tsx's
 * CLI wrapper (node_modules/tsx/dist/cli.mjs), which itself forks a SEPARATE child process to
 * actually run argus-engine.ts (confirmed live via Win32_Process parent/child inspection: two
 * distinct node.exe PIDs, wrapper -> real engine - the exact topology the pid-reconciliation block
 * in startEngine() below was written to work around). That two-process shape is a real risk on
 * Windows: this host has already demonstrated non-standard process semantics once (DEF-26 -
 * process.kill(pid, 'SIGTERM') never invokes the target's own handler here), so a wrapper parent
 * exiting for any reason - expected or not - can plausibly tear down its child via Windows Job
 * Object propagation even with detached:true, which decouples reliably on POSIX but not always on
 * Windows. That would produce exactly the observed signature: the real engine stops with no JS
 * exception, no crash.log entry, and no SIGTERM handler ever invoked.
 *
 * Fix: invoke tsx's own PUBLIC loader hooks directly on `node` (package.json exports "." ->
 * dist/loader.mjs, "./preflight" -> dist/preflight.cjs - the same mechanism tsx's own README
 * documents as `node --import tsx ./file.ts`), so the spawned process IS the real engine - no
 * wrapper, no parent-child chain, so this failure mode becomes structurally impossible rather than
 * merely unlikely. Verified live (2026-09-04): exactly one node.exe process after this change,
 * versus two (wrapper + child) before it.
 */
export function buildEngineSpawnArgs(useProd: boolean, root: string): { args: string[] } {
  if (useProd) {
    return { args: [join(root, 'scripts', 'argus-engine-prod.mjs')] };
  }
  return {
    args: [
      '--require', 'tsx/preflight',
      '--import', 'tsx',
      join(root, 'scripts', 'argus-engine.ts'),
    ],
  };
}

async function startEngine() {
  const flags = parseFlags(process.argv.slice(3));
  if (isEngineProcessRunning()) {
    console.log(JSON.stringify({ ok: true, message: 'Engine already running', pid: readEnginePid() }, null, 2));
    return;
  }
  const distServer = join(ROOT, 'dist', 'server.cjs');
  // Explicit --prod only; --dev (or default) uses tsx engine entry. Never auto-pick prod just because dist exists.
  const useProd = flags.prod && !flags.dev;
  if (useProd && !existsSync(distServer)) {
    throw new Error('Production start requested but dist/server.cjs is missing. Run: npm run build');
  }
  // Snapshot whatever is answering /health right now (should normally be nothing, since
  // isEngineProcessRunning() above returned false - but the whole point of this check is to
  // catch exactly the case where the pid file lies and something is still actually listening).
  //
  // Real defect fixed (2026-09-12, live-reproduced): this used to be recorded for a nicer
  // post-failure message only - it never actually stopped the spawn below. Combined with
  // waitForHealthGone()'s now-fixed slow-server-misread-as-gone bug (see probeHealth()'s doc
  // comment), a restart during a busy moment could conclude the old process was gone, clear the
  // pid file, and let startEngine() spawn a brand-new engine while the old one was still actually
  // bound to the port - the new spawn then failed to bind, but kept running as a fully-live,
  // untracked, unreachable-via-HTTP second engine (real IBKR/Ollama/broker connections; only
  // stopped when it later crashed on its own). Refusing to spawn at all when something is already
  // answering is the correct, safe behavior here - the operator-facing message already existed,
  // it just needs to run BEFORE spawning a doomed duplicate, not after.
  const staleAnsweringPid = await currentlyAnsweringPid();
  if (staleAnsweringPid !== undefined) {
    console.log(JSON.stringify({
      ok: false,
      message: `Refusing to start a new engine: pid ${staleAnsweringPid} is already answering ${BASE}/health, even though this CLI's own pid file did not report it as running. Stop pid ${staleAnsweringPid} (or investigate why it is untracked) before starting a new one - spawning anyway would create a second, real, untracked engine process.`,
      pid: staleAnsweringPid,
    }, null, 2));
    process.exit(1);
  }
  const env = { ...process.env, ARGUS_HEADLESS: 'true', ARGUS_ENGINE: 'true' };
  const spawnSpec = buildEngineSpawnArgs(useProd, ROOT);
  const child = spawn(process.execPath, spawnSpec.args, { cwd: ROOT, env, detached: true, stdio: 'ignore' });
  if (!child.pid) throw new Error('Failed to spawn Argus engine process');
  writeEnginePid(child.pid);
  child.unref();
  // Real-world boot time on this machine consistently runs 65-75s (ArgusCoreBoot + migrations +
  // model probes), past a 60s cap - repeatedly observed reporting a false "health check timed out"
  // moments before /health actually came up healthy. Default raised to 150s; still overridable.
  const startTimeoutMs = Number(process.env.ARGUS_CLI_START_TIMEOUT_MS || 150_000);
  // staleAnsweringPid is always undefined here (the guard above already exited otherwise) - this
  // spawn is the only thing that can legitimately answer /health from this point forward.
  const ready = await waitForHealth(startTimeoutMs);
  const message = ready ? 'Engine started' : 'Engine spawned but health check timed out';
  let reportedPid = child.pid;
  if (ready && !useProd) {
    // Originally written (2026-08-25) to reconcile the pid file when --dev mode spawned tsx's CLI
    // wrapper, which forked a separate real-engine child under a different pid. 2026-09-04: that
    // wrapper is gone (see the spawn above) - `child.pid` is now already the real serving process,
    // so `realPid` below is expected to always equal it. Left in place as a harmless defensive
    // no-op rather than removed: if a future change ever reintroduces an intermediary process, the
    // pid file still self-corrects to whatever /health actually reports instead of going stale.
    const realPid = await currentlyAnsweringPid();
    if (realPid !== undefined && realPid !== child.pid) {
      writeEnginePid(realPid);
      reportedPid = realPid;
    }
  }
  console.log(JSON.stringify({
    ok: ready,
    pid: reportedPid,
    headless: true,
    api: BASE,
    message,
  }, null, 2));
  if (!ready) process.exit(1);
  // --enable-trading (2026-09-15): chains the same resumeTrading() operator-resume path a separate
  // `argus-cli resume` call would use, right after a successful boot - for exactly the case this
  // was added for (starting today's session and enabling it in one step). This does NOT weaken or
  // skip anything: resumeTrading() hits the real /api/v1/system/resume route, which still applies
  // every existing server-side safety check (reconciliation, restart safety, etc.) exactly as it
  // would for a standalone `resume` call. If that check refuses (e.g. a real reconciliation
  // mismatch), this reports the failure below and leaves the engine running but NOT trading -
  // it never falls back to a bypass. Printed BEFORE the health report so that report reflects the
  // post-resume tradingState, not the pre-resume one.
  if (flags.enableTrading) {
    const reason = resumeReasonFromArgv(process.argv.slice(3), 'Auto-resume via argus-cli start --enable-trading');
    try {
      const resumeResult = await resumeTrading(reason);
      console.log(JSON.stringify({ enableTrading: true, resumeResult }, null, 2));
    } catch (e: any) {
      console.error(JSON.stringify({
        enableTrading: true,
        ok: false,
        message: `Engine started but resume failed: ${e.message || e}. Trading remains whatever state it was already in - not forced.`,
      }, null, 2));
    }
  }
  // "make sure everything is working fine" - print the same broker/AI-provider/Kronos/
  // QuantCoreBridge picture `argus-cli health` gives, right here, instead of requiring a separate
  // manual follow-up command to see it.
  await printFullHealthReport();
  // 2026-10-05 (operator request): starting the app also starts the watchdog, so there is never
  // a running engine with no supervisor. startWatchdog() is idempotent (no-op if already running).
  // Opt out with --no-watchdog for maintenance/debug sessions.
  if (!flags.noWatchdog) {
    try {
      await startWatchdog();
    } catch (e: any) {
      console.error(JSON.stringify({
        ok: false,
        message: `Engine started but watchdog failed to start: ${e.message || e}. Engine is running UNSUPERVISED - start the watchdog manually with: argus watchdog-start`,
      }, null, 2));
    }
  }
}

async function stopEngine() {
  const pid = readEnginePid();
  if (!pid) {
    console.log(JSON.stringify({ ok: true, message: 'No engine PID file' }, null, 2));
    return;
  }
  // PID-reuse guard: if the original engine crashed without clearing the pid file and the OS
  // later reassigned this exact PID to an unrelated process, sending SIGTERM would kill a
  // stranger, not Argus. isPidLikelyArgusProcess fails open (returns true) when it can't verify,
  // so this only ever blocks a stop when it has positive evidence the PID is NOT Argus.
  const looksLikeArgus = await isPidLikelyArgusProcess(pid);
  if (!looksLikeArgus) {
    clearEnginePid();
    console.log(JSON.stringify({
      ok: false,
      message: `Refusing to signal pid ${pid} - it is alive but its command line does not look like an Argus engine process (likely PID reuse after an unclean prior exit). Cleared the stale pid file instead of sending SIGTERM.`,
      pid,
    }, null, 2));
    return;
  }

  // DEF-26 fix (2026-08-26): `process.kill(pid, 'SIGTERM')` does not invoke the target process's
  // SIGTERM handler on Windows - empirically confirmed live (isolated parent/child probe: the
  // child was force-terminated, handler never ran, both cross-process and via self-signal). Every
  // prior stop/restart on this platform was therefore an unconditional hard-kill, never a real
  // drain - which is exactly why the successor process's "did not shut down cleanly" report was
  // accurate, not a logging bug (see gracefulShutdown.ts's requestGracefulShutdown()). Prefer a
  // real graceful shutdown via HTTP (same-process function call, no OS signal involved); fall back
  // to SIGTERM only when that request itself cannot be made (server unreachable/wedged).
  let gracefulRequested = false;
  try {
    await fetchJson('/api/v1/system/shutdown', { method: 'POST' });
    gracefulRequested = true;
  } catch (e) {
    if (e instanceof AuthRequiredError) throw e;
    /* fall through to the SIGTERM fallback below */
  }

  if (gracefulRequested) {
    const stopped = await waitForHealthGone(15_000);
    clearEnginePid();
    console.log(JSON.stringify({
      ok: true,
      message: stopped
        ? 'Graceful shutdown requested and confirmed (process stopped answering /health).'
        : 'Graceful shutdown requested but the process was still answering /health after 15s - it may still be draining, or may be wedged. Check the process directly before assuming it is stopped.',
      pid,
      graceful: true,
    }, null, 2));
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e: unknown) {
    clearEnginePid();
    throw e;
  }
  clearEnginePid();
  // No positive confirmation the port is free yet in this fallback path (unlike the graceful
  // path's waitForHealthGone) - give the OS a brief moment before a caller tries to start a new
  // engine on the same port.
  await new Promise((r) => setTimeout(r, 1000));
  console.log(JSON.stringify({
    ok: true,
    message: 'Graceful HTTP shutdown request failed (server unreachable) - sent SIGTERM as a fallback. On Windows this forcefully terminates the process without running its drain sequence; the next boot will correctly report an unclean shutdown, because this one genuinely was.',
    pid,
    graceful: false,
  }, null, 2));
}

/**
 * "closing this tab should not bring argus down" (2026-09-08, operator report): the watchdog was
 * only ever launchable via `npm run argus:watchdog` run directly in a foreground terminal - live
 * process-tree inspection that session showed it as a child of that terminal's bash -> npm -> cmd
 * chain, with no detachment at all. That npm script also still spawns tsx's CLI wrapper
 * (node_modules/tsx/dist/cli.mjs), the exact wrapper-forks-a-real-child shape the engine's own
 * startEngine()/buildEngineSpawnArgs() comment above documents as a live Windows Job Object risk
 * (a wrapper parent exiting - e.g. its owning terminal tab closing - can tear down its child even
 * with detached:true). `watchdog start` below spawns the watchdog the same safe, wrapper-free way
 * buildEngineSpawnArgs() already does for the engine (node --require tsx/preflight --import tsx
 * <file>, detached:true, stdio:'ignore', unref()), so it survives its launching terminal closing.
 */
export function buildWatchdogSpawnArgs(root: string): { args: string[] } {
  return {
    args: [
      '--require', 'tsx/preflight',
      '--import', 'tsx',
      join(root, 'scripts', 'argusWatchdog.ts'),
    ],
  };
}

async function startWatchdog() {
  if (isWatchdogProcessRunning()) {
    console.log(JSON.stringify({ ok: true, message: 'Watchdog already running', pid: readWatchdogPid() }, null, 2));
    return;
  }
  const spawnSpec = buildWatchdogSpawnArgs(ROOT);
  const child = spawn(process.execPath, spawnSpec.args, { cwd: ROOT, env: process.env, detached: true, stdio: 'ignore' });
  if (!child.pid) throw new Error('Failed to spawn Argus watchdog process');
  writeWatchdogPid(child.pid);
  child.unref();
  console.log(JSON.stringify({ ok: true, pid: child.pid, message: 'Watchdog started (detached).' }, null, 2));
}

async function stopWatchdog() {
  const pid = readWatchdogPid();
  if (!pid) {
    console.log(JSON.stringify({ ok: true, message: 'No watchdog PID file' }, null, 2));
    return;
  }
  if (!isPidAlive(pid)) {
    clearWatchdogPid();
    console.log(JSON.stringify({ ok: true, message: 'Watchdog PID file was stale (process already gone).', pid }, null, 2));
    return;
  }
  // The watchdog installs no SIGTERM handler of its own (it holds no DB connection / broker state
  // to drain) - on this platform SIGTERM unconditionally terminates the target (same Windows
  // behavior DEF-26 documented for the engine), which is exactly what's wanted here.
  try {
    process.kill(pid, 'SIGTERM');
  } finally {
    clearWatchdogPid();
  }
  console.log(JSON.stringify({ ok: true, message: 'Watchdog stopped.', pid }, null, 2));
}

async function cliLogin() {
  const creds = resolveCliCredentials();
  if (!creds) {
    console.error(
      'Missing credentials. Set ARGUS_CLI_USER + ARGUS_CLI_PASSWORD, or AUTH_USERNAME + AUTH_PASSWORD ' +
        '(password is never printed). Server must have AUTH_PASSWORD configured for login to succeed.',
    );
    process.exit(EXIT_AUTH);
  }
  const timeoutMs = Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000);
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: creds.username, password: creds.password }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err =
      typeof body === 'object' && body && 'error' in (body as object)
        ? String((body as { error: string }).error)
        : `HTTP ${res.status}`;
    console.error(`Login failed: ${err}`);
    // Never echo password or cookie
    process.exit(EXIT_AUTH);
  }
  const cookiePair = parseSessionCookieFromSetCookie(collectSetCookieHeaders(res.headers));
  if (!cookiePair) {
    console.error('Login succeeded but no argus_session cookie was returned.');
    process.exit(1);
  }
  writeSessionCookie(SESSION_PATH, cookiePair);
  console.log(JSON.stringify({
    ok: true,
    message: 'CLI session saved',
    sessionFile: SESSION_PATH,
    credentialSource: creds.source,
    // Do not print cookie or password
  }, null, 2));
}

async function cliLogout() {
  const headers = cliAuthHeaders();
  try {
    if (headers.Cookie) {
      await fetch(`${BASE}/api/v1/auth/logout`, {
        method: 'POST',
        signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: '{}',
      });
    }
  } catch {
    /* still clear local file */
  }
  clearSessionFile(SESSION_PATH);
  console.log(JSON.stringify({ ok: true, message: 'CLI session cleared', sessionFile: SESSION_PATH }, null, 2));
}

const replayCommands: Record<string, () => Promise<void>> = {
  async list() {
    console.log(JSON.stringify(await fetchJson('/api/v2/historical-evaluations'), null, 2));
  },
  async run() {
    const args = parseReplayArgs(process.argv.slice(4));
    if ((args.engine || 'node').toLowerCase() === 'java') {
      return runJavaReplay(args);
    }
    const universe = (args.universe || 'discovery').toLowerCase();
    const body: Record<string, unknown> = {
      initialCapital: Number(args.capital || 100000),
      allocationBudget: Number(args.capital || 100000),
      startDate: args.start || '2024-01-02',
      endDate: args.end || '2024-12-31',
      dataProvider: args.provider || 'golden_replay',
      aiMode: 'DISABLED',
      speed: 'MAX',
      randomSeed: 1,
    };
    if (universe === 'symbols' || universe === 'operator') {
      body.universeSource = 'OPERATOR_SELECTED';
      body.symbols = (args.symbols || 'AAPL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else {
      body.universeSource = 'ARGUS_DISCOVERY';
    }
    const created = await fetchJson('/api/v2/historical-evaluations', { method: 'POST', body: JSON.stringify(body) }) as { replayId?: string };
    if (!created.replayId) {
      console.log(JSON.stringify(created, null, 2));
      return;
    }
    console.log(JSON.stringify(await fetchJson(`/api/v2/research/replay/${created.replayId}/start?async=0`, { method: 'POST', body: '{}' }), null, 2));
  },
  async report() {
    const id = parseReplayArgs(process.argv.slice(4)).runId;
    if (!id) usageError('Usage: argus replay report <runId>');
    console.log(JSON.stringify(await fetchJson(`/api/v2/historical-evaluations/${id}/report`), null, 2));
  },
  async export() {
    const id = parseReplayArgs(process.argv.slice(4)).runId;
    if (!id) usageError('Usage: argus replay export <runId>');
    const res = await fetch(`${BASE}/api/v2/historical-evaluations/${id}/export?format=zip`, {
      headers: cliAuthHeaders(),
    });
    if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    process.stdout.write(Buffer.from(await res.arrayBuffer()));
  },
  /** Forensic view of existing report evidence — does not invent analysis or change risk/consensus. */
  async analyze() {
    const id = parseReplayArgs(process.argv.slice(4)).runId;
    if (!id) usageError('Usage: argus replay analyze <runId>');
    const report = await fetchJson(`/api/v2/historical-evaluations/${id}/report`);
    console.log(JSON.stringify({
      mode: 'historical_evaluation_analyze',
      note: 'Exposes existing report evidence only. Does not auto-tune risk, consensus, or weights.',
      report,
    }, null, 2));
  },
  async diagnostics() {
    const id = parseReplayArgs(process.argv.slice(4)).runId;
    if (!id) usageError('Usage: argus replay diagnostics <runId>');
    const meta = await fetchJson(`/api/v2/historical-evaluations/${id}`);
    let report: unknown = null;
    try {
      report = await fetchJson(`/api/v2/historical-evaluations/${id}/report`);
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      report = { unavailable: true };
    }
    console.log(JSON.stringify({
      mode: 'historical_evaluation_diagnostics',
      note: 'Run metadata + report when available. Not organic paper. Not LIVE.',
      meta,
      report,
    }, null, 2));
  },
};

/**
 * Per-command help registry (2026-10-04). `argus <command> --help` prints the
 * entry instead of running the command, so all 83 commands are self-
 * documenting without opening the browser UI or reading source. Commands with
 * richer native help (research) keep their own handler and are excluded from
 * the global --help interception below.
 */
export const COMMAND_HELP: Record<string, string> = {
  'version': 'Usage: argus version\nPrint CLI version and the API endpoint in use.',
  'login': 'Usage: argus login\nAuthenticate the CLI. Reads ARGUS_CLI_USER + ARGUS_CLI_PASSWORD (or AUTH_USERNAME + AUTH_PASSWORD) from the environment and stores a session cookie. The password is never printed.',
  'logout': 'Usage: argus logout\nClear the stored CLI session.',
  'start': 'Usage: argus start [--enable-trading] [--dev] [--no-watchdog]\nStart the Argus engine (headless daemon). The watchdog supervisor auto-starts too unless --no-watchdog is given. Use `argus help` / ./argus for process-mode details.',
  'stop': 'Usage: argus stop\nStop the Argus engine gracefully (waits for /health to stop answering).',
  'restart': 'Usage: argus restart\nStop then start the engine.',
  'watchdog-start': 'Usage: argus watchdog-start\nStart the detached auto-restart supervisor.',
  'watchdog-stop': 'Usage: argus watchdog-stop\nStop the watchdog supervisor.',
  'watchdog-restart': 'Usage: argus watchdog-restart\nRestart the watchdog supervisor.',
  'watchdog-status': 'Usage: argus watchdog-status\nShow whether the watchdog is running and its PID.',
  'status': 'Usage: argus status\nEngine runtime status (JSON).',
  'health': 'Usage: argus health [--json]\nFull health report: runtime, broker, AI providers, Kronos/Chronos, QuantCore. --json prints pure JSON for scripting.',
  'ready': 'Usage: argus ready\nLive-readiness snapshot (paper/live posture, gates).',
  'wait-ready': 'Usage: argus wait-ready [--timeout-ms=N]\nBlock until the API answers /health (default timeout 240s). Prints progress.',
  'resume': 'Usage: argus resume [--reason="..."]\nResume autonomous trading (operator-controlled; records the reason).',
  'pause': 'Usage: argus pause [--reason="..."]\nPause autonomous trading (records the reason).',
  'set-broker': 'Usage: argus set-broker <id>\nSwitch the active execution broker at runtime (e.g. alpaca, ibkr_gateway, internal_paper). Persists to settings.',
  'brokers': 'Usage: argus brokers [--json]\nList broker capabilities and saved connections (table; --json for raw JSON).',
  'research-recommend': 'Usage: argus research-recommend [--strategy=<id>]\nShow research recommendations.',
  'provider-health': 'Usage: argus provider-health\nAI provider pool health.',
  'opportunity-snapshot': 'Usage: argus opportunity-snapshot [--limit=N]\nLatest opportunity snapshot.',
  'execution-quality': 'Usage: argus execution-quality [--limit=N]\nExecution quality / slippage report.',
  'trade-economic-attribution': 'Usage: argus trade-economic-attribution [--limit=N] [--scope=<scope>]\nPer-trade economic attribution.',
  'daily-attribution': 'Usage: argus daily-attribution [--since=<date>]\nDaily P&L attribution.',
  'forecast': 'Usage: argus forecast --agent=<agent> --symbol=<SYM> --direction=BUY|SELL [--strategyId=<id>] [--horizon=<h>]\nRequest a forecast from an agent (advisory only).',
  'consensus-debate-health': 'Usage: argus consensus-debate-health [--hours=N]\nConsensus debate pipeline health.',
  'consensus-report': 'Usage: argus consensus-report [--hours=N]\nConsensus report over the window.',
  'risk-recent': 'Usage: argus risk-recent [--limit=N]\nRecent risk events.',
  'trading-funnel': 'Usage: argus trading-funnel [--hours=N]\nTrading funnel conversion over the window.',
  'quant-evidence': 'Usage: argus quant-evidence [--hours=N]\nQuant evidence summary.',
  'portfolio-impact': 'Usage: argus portfolio-impact --symbol=<SYM> [--side=BUY|SELL] [--notional=1000] [--maxWeightPct=0.20] [--lookbackTradingDays=90]\nAdvisory-only portfolio impact estimate. Never places or sizes an order.',
  'calibration-drift': 'Usage: argus calibration-drift\nCalibration drift report.',
  'reflection-engine-health': 'Usage: argus reflection-engine-health\nReflection engine health.',
  'extended-hours-spread': 'Usage: argus extended-hours-spread [--hours=N]\nExtended-hours spread diagnostics.',
  'why-no-trade': 'Usage: argus why-no-trade [--symbol=<SYM>]\nExplain why Argus is not trading (blocking gates).',
  'calibration-maturity': 'Usage: argus calibration-maturity\nCalibration maturity report.',
  'agent-edge': 'Usage: argus agent-edge\nPer-agent edge estimates.',
  'multi-horizon-outcomes': 'Usage: argus multi-horizon-outcomes\nMulti-horizon outcome tracking.',
  'strategy-catalog': 'Usage: argus strategy-catalog\nStrategy catalog.',
  'strategy-readiness': 'Usage: argus strategy-readiness\nStrategy readiness for promotion.',
  'strategy-fairness': 'Usage: argus strategy-fairness\nStrategy fairness / comparison.',
  'strategy-recertification': 'Usage: argus strategy-recertification\nStrategy recertification status.',
  'strategy-score-normalization-comparison': 'Usage: argus strategy-score-normalization-comparison\nScore normalization comparison.',
  'strategy-profitability': 'Usage: argus strategy-profitability\nStrategy profitability summary.',
  'rescue-outcomes': 'Usage: argus rescue-outcomes\nRescue / intervention outcomes.',
  'exploration-health': 'Usage: argus exploration-health\nExploration subsystem health.',
  'rescue-occupants': 'Usage: argus rescue-occupants\nCurrent rescue occupants.',
  'market-data-diagnostics': 'Usage: argus market-data-diagnostics [--symbols=AAPL,MSFT]\nMarket-data feed diagnostics.',
  'ai-cost-governor': 'Usage: argus ai-cost-governor\nAI cost governor status.',
  'discovery-challengers': 'Usage: argus discovery-challengers [--hours=N]\nDiscovery challenger strategies.',
  'discovery-lineage': 'Usage: argus discovery-lineage --symbol=<SYM> [--hours=N]\nLineage of a discovered opportunity.',
  'strategy-scorecard': 'Usage: argus strategy-scorecard\nStrategy scorecard.',
  'pipeline-ready': 'Usage: argus pipeline-ready\nPipeline readiness check.',
  'session-report': 'Usage: argus session-report\nSession report.',
  'research': 'Usage: argus research <subcommand> [args]\nResearch intelligence (advisory only, never a trade). Run `argus research --help` for subcommands.',
  'trading-audit': 'Usage: argus trading-audit\nTrading audit trail.',
  'funnel': 'Usage: argus funnel <traceId>\nShow the trading funnel for a trace ID.',
  'consensus-shadow': 'Usage: argus consensus-shadow [limit]\nLegacy-vs-shadow consensus divergence (shadow never influences real trades).',
  'ranking': 'Usage: argus ranking [SYMBOL]\nLatest candidate ranking, or ranking history for SYMBOL.',
  'subscription-queue': 'Usage: argus subscription-queue [decisions]\nSubscription priority queue snapshot; `decisions` shows promotion/eviction reasons.',
  'trade-plan': 'Usage: argus trade-plan [date] [planId]\nPre-market trade plan (default: today); with planId shows revalidations.',
  'missed-opportunities': 'Usage: argus missed-opportunities [sinceMs]\nDetected missed opportunities (default 24h lookback).',
  'learning': 'Usage: argus learning <observations|versions|promotions|rollbacks|calibration [worker-status]> [args...]\nLearning / self-evolution observability.',
  'session-lifecycle': 'Usage: argus session-lifecycle\nSession lifecycle snapshot + recent history.',
  'config': 'Usage: argus config\nRuntime config (JSON).',
  'paper-profile': 'Usage: argus paper-profile [--apply]\nPaper allocation profile. --apply requires confirmed PAPER mode, disabled Autobot and TRADING_PAUSED; otherwise dry-run.',
  'positions': 'Usage: argus positions [--json]\nCurrent positions (table; --json for raw JSON).',
  'portfolio': 'Usage: argus portfolio [--json]\nPortfolio snapshot (alias of positions; table; --json for raw JSON).',
  'orders': 'Usage: argus orders [--json]\nRecent orders (table; --json for raw JSON).',
  'trades': 'Usage: argus trades [--json]\nRecent trades (table; --json for raw JSON).',
  'logs': 'Usage: argus logs [--json]\nRecent system logs, limit 50 (table; --json for raw JSON).',
  'enable': 'Usage: argus enable\nEnable autonomous trading (operator-controlled).',
  'disable': 'Usage: argus disable\nDisable autonomous trading (operator-controlled).',
  'kill-switch': 'Usage: argus kill-switch --confirm [--reason="..."]\nEMERGENCY STOP: halts ALL trading immediately. Requires --confirm.',
  'agents': 'Usage: argus agents [--json]\nPipeline agents and status (table; --json for raw JSON).',
  'events': 'Usage: argus events [--json]\nRecent system events, limit 50 (table; --json for raw JSON).',
  'risk': 'Usage: argus risk\nRisk engine status.',
  'quant-core': 'Usage: argus quant-core\nJava Quant Core connectivity and health.',
  'parity': 'Usage: argus parity\nTS/Java shadow-parity divergences.',
  'discovery': 'Usage: argus discovery\nContinuous-intelligence discovery status.',
  'campaign': 'Usage: argus campaign\nDaily goal campaign status.',
  'replay': 'Usage: argus replay <subcommand> [args]\nHistorical evaluation (MODE B). Run `argus replay help` for subcommands.',
  'doctor': 'Usage: argus doctor\nEnvironment + API health checks (like `brew doctor`). Exits non-zero on critical failures.',
  'completion': 'Usage: argus completion [bash|zsh]\nPrint a shell completion script for argus-cli command names.',
  'help': 'Usage: argus help\nShow the categorized command list.',
};

/**
 * Suggest similar command names for typos (git-style "did you mean?").
 * Exported for tests.
 */
export function suggestCommands(input: string, names: string[], maxDistance = 3, maxResults = 3): string[] {
  const distance = (a: string, b: string): number => {
    const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return dp[a.length][b.length];
  };
  return names
    .map((n) => ({ n, d: distance(input, n) }))
    .filter(({ d }) => d > 0 && d <= maxDistance)
    .sort((x, y) => x.d - y.d || x.n.localeCompare(y.n))
    .slice(0, maxResults)
    .map(({ n }) => n);
}

const commands: Record<string, () => Promise<void>> = {
  async version() {
    let version = '0.0.0';
    try {
      version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? version;
    } catch {
      /* ignore */
    }
    // package.json carries 0.0.0 in this repo; report the git commit so
    // `argus version` still identifies the running build (provenance matters
    // for a trading system — the Monday gate asks what build is deployed).
    let commit: string | null = null;
    if (version === '0.0.0') {
      try {
        const { execSync } = await import('node:child_process');
        commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, timeout: 5000 })
          .toString()
          .trim() || null;
      } catch {
        /* not a git checkout or git unavailable */
      }
    }
    console.log(JSON.stringify({
      ok: true,
      name: 'argus-cli',
      version: commit ? `${version}+${commit}` : version,
      api: BASE,
      role: 'HTTP client for Argus Engine (not a trading brain)',
    }, null, 2));
  },
  async login() {
    return cliLogin();
  },
  async logout() {
    return cliLogout();
  },
  async start() {
    return startEngine();
  },
  async stop() {
    return stopEngine();
  },
  async restart() {
    // stopEngine() itself now waits for confirmation the old process actually stopped answering
    // /health (graceful path) or applies its own short buffer (SIGTERM fallback) - no need for an
    // additional blind fixed delay here on top of that (DEF-26 fix, 2026-08-26).
    await stopEngine().catch(() => undefined);
    return startEngine();
  },
  async 'watchdog-start'() {
    return startWatchdog();
  },
  async 'watchdog-stop'() {
    return stopWatchdog();
  },
  async 'watchdog-restart'() {
    await stopWatchdog().catch(() => undefined);
    return startWatchdog();
  },
  async 'watchdog-status'() {
    const running = isWatchdogProcessRunning();
    console.log(JSON.stringify({ ok: true, running, pid: running ? readWatchdogPid() : null }, null, 2));
  },
  async status() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/status'), null, 2));
  },
  async health() {
    return printFullHealthReport(process.argv.slice(3).includes('--json'));
  },
  async ready() {
    console.log(JSON.stringify(await fetchJson('/api/v2/live-readiness'), null, 2));
  },
  async 'wait-ready'() {
    // CLI/control-plane hardening (2026-09-23) - headless/engine-daemon counterpart to argus.sh's
    // ecosystem-mode `wait-ready`. Blocks until the API genuinely answers /health, printing
    // progress rather than sitting silent, with a real bounded timeout (never nonzero purely for
    // a slow-but-legitimate boot). Override with --timeout-ms=N (default 240000, matching
    // ARGUS_CLI_START_TIMEOUT_MS's own real-world-observed 65-150s+ boot time headroom).
    const timeoutArg = process.argv.slice(3).find((a) => a.startsWith('--timeout-ms='));
    const timeoutMs = timeoutArg ? Number(timeoutArg.slice('--timeout-ms='.length)) : 240_000;
    console.log(`Waiting for Argus API to become ready (up to ${Math.round(timeoutMs / 1000)}s; override with --timeout-ms=N)...`);
    const ready = await waitForHealthReady(timeoutMs, (waitedMs) => {
      console.log(`  ...still waiting (${Math.round(waitedMs / 1000)}s elapsed).`);
    });
    if (ready) {
      console.log('');
      console.log('ARGUS READY');
      console.log('');
      console.log(`API: ${BASE}`);
      console.log('UI:  ' + BASE + '  (Vite is mounted as Express middleware on the same port when web UI is enabled - no separate UI port exists in this deployment)');
      return;
    }
    console.log('');
    console.log(`Argus API did not become ready within ${Math.round(timeoutMs / 1000)}s.`);
    console.log('This may be a genuine failure, or a slower-than-usual boot. Check the engine log, or run: npm run argus-cli -- status');
    process.exitCode = 1;
  },
  async resume() {
    // Full-remediation pass (2026-09-04, docs/audits/ARGUS_FULL_PAPER_TRADING_REMEDIATION_2026-09-04.md
    // §28 Paper-Trading Resume Safety): the real tradingState resume path - see resumeTrading()'s
    // own doc comment. Operator-controlled by design (this command, or `start --enable-trading`,
    // both explicit human/authorized-caller actions - never called automatically on a timer by
    // anything in this codebase). Pass --reason="..." to record why; defaults to a generic reason.
    const reason = resumeReasonFromArgv(process.argv.slice(3), 'Operator resume via argus-cli');
    console.log(JSON.stringify(await resumeTrading(reason), null, 2));
  },
  async pause() {
    const reasonArg = process.argv.slice(3).find((a) => a.startsWith('--reason='));
    const reason = reasonArg ? reasonArg.slice('--reason='.length) : 'Operator pause via argus-cli';
    console.log(JSON.stringify(await fetchJson('/api/v1/system/pause', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }), null, 2));
  },
  /**
   * 2026-09-29: real, missing CLI capability found while operating Argus - switching the active
   * execution broker at runtime required a raw authenticated HTTP call to POST /api/v1/brokers/active
   * (integrationRoutes.ts); there was no CLI command for it, unlike resume/pause. This is a thin
   * wrapper over that same existing route - BrokerManager.setActiveBroker() remains the sole
   * router, this file still never imports it directly. The route itself persists the selection to
   * settings.selectedBroker (survives a restart) and applies PAPER_TRADING_ONLY/IBKR preflight
   * checks server-side, same as switching via the UI.
   */
  async 'set-broker'() {
    const id = cliArgs()[0];
    if (!id) usageError('Usage: argus set-broker <id>  (e.g. alpaca, ibkr_gateway, internal_paper)');
    console.log(JSON.stringify(await fetchJson('/api/v1/brokers/active', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }), null, 2));
  },
  async brokers() {
    const data = await fetchJson('/api/v1/brokers') as { brokers?: any[]; activeBrokerId?: string } | any[];
    if (isJsonOutput()) return printJson(data);
    // The endpoint returns a bare array; tolerate a wrapped shape too.
    const list = Array.isArray(data) ? data : (data.brokers ?? []);
    const activeId = Array.isArray(data) ? undefined : data.activeBrokerId;
    const rows = list.map((b: any) => ({
      ...b,
      _active: b.id === activeId || b.isActive ? 'ACTIVE' : '',
    }));
    printTable(rows, [
      { header: 'ID', pick: (r) => field(r, 'id') },
      { header: 'NAME', pick: (r) => field(r, 'name', 'label', 'displayName') },
      { header: 'STATUS', pick: (r) => field(r, 'status', 'state', 'health') },
      { header: '', pick: (r) => r._active ?? '' },
    ]);
  },
  async 'research-recommend'() {
    // LangGraph research service (docs/architecture/ARGUS_ARCHITECTURE.md (LangGraph Research Service section)) - shadow-only,
    // never auto-promotes. Pass --strategy=MOMENTUM_BREAKOUT (default GOLDEN_SMA).
    // Phase 3.1 (2026-09-03): POST is now asynchronous by construction (see researchRoutes.ts) -
    // it returns a PENDING runId in milliseconds rather than blocking for the real 11-16s LLM
    // call, which used to race this CLI's own fetch timeout (and, server-side, server.ts's 15s
    // watchdog). This command now polls the existing read-only recommendation route until the run
    // reaches a terminal status, preserving the same "one command, one final answer" UX for an
    // operator without the underlying HTTP contract needing to stay synchronous.
    const strategyArg = process.argv.slice(3).find((a) => a.startsWith('--strategy='));
    const strategyId = strategyArg ? strategyArg.slice('--strategy='.length) : 'GOLDEN_SMA';
    const begun = await fetchJson(`/api/v2/research/strategy-graduation/${encodeURIComponent(strategyId)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000), // this call itself is now fast - no 60s needed
    }) as { ok?: boolean; runId?: string; status?: string };

    if (!begun.runId || begun.status !== 'PENDING') {
      console.log(JSON.stringify(begun, null, 2)); // already terminal (e.g. MAX_CONCURRENCY_REACHED)
      return;
    }

    const TERMINAL = new Set(['COMPLETED', 'FAILED', 'UNAVAILABLE', 'TIMEOUT', 'CANCELLED', 'FAILED_ON_RESTART']);
    const deadline = Date.now() + 60_000; // covers requestTimeoutMs (45s) + round-trip overhead
    let last: unknown = begun;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 750));
      const view = await fetchJson(`/api/v2/research/strategy-recommendations/${encodeURIComponent(begun.runId)}`);
      last = view;
      if (TERMINAL.has((view as { status?: string })?.status || '')) break;
    }
    console.log(JSON.stringify(last, null, 2));
  },
  async 'provider-health'() {
    // Phase 9 (2026-08-27): real per-provider health matrix - DB aggregates + AIRouter's live
    // routing snapshot, never a new live probe burning real provider quota just for this report.
    console.log(JSON.stringify(await fetchJson('/api/v2/observability/provider-health-matrix'), null, 2));
  },
  async 'opportunity-snapshot'() {
    // 2026-09-13 (Institutional Transformation Mandate Part 8/9): real evidence-ranked recent
    // QuantEngine ideas - no fabricated expected-return score. Pass --limit=N (default 20).
    const limitArg = process.argv.slice(3).find((a) => a.startsWith('--limit='));
    const url = limitArg
      ? `/api/v2/observability/opportunity-snapshot?format=text&limit=${encodeURIComponent(limitArg.slice('--limit='.length))}`
      : `/api/v2/observability/opportunity-snapshot?format=text`;
    const res = await fetch(`${BASE}${url}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 15_000)),
    });
    console.log(await res.text());
  },
  async 'execution-quality'() {
    // 2026-09-13 (Institutional Transformation Mandate Part 16): real slippage - trades.arrival_price
    // (written once at order insert, never overwritten) vs real matching fills. Pass --limit=N.
    const limitArg = process.argv.slice(3).find((a) => a.startsWith('--limit='));
    const url = limitArg
      ? `/api/v2/observability/execution-quality?format=text&limit=${encodeURIComponent(limitArg.slice('--limit='.length))}`
      : `/api/v2/observability/execution-quality?format=text`;
    const res = await fetch(`${BASE}${url}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 15_000)),
    });
    console.log(await res.text());
  },
  async 'trade-economic-attribution'() {
    // 2026-09-23 (Argus World-Class Open-Source Quant Expansion roadmap, Priority #2): real
    // gross/net P&L + canonical cost breakdown per trade leg. Pass --limit=N and/or --scope=X
    // (PAPER_ORGANIC|PAPER_MANUAL|PAPER_UNATTRIBUTED|REPLAY|BACKTEST|SIMULATION|LIVE|UNKNOWN).
    const args = process.argv.slice(3);
    const limitArg = args.find((a) => a.startsWith('--limit='));
    const scopeArg = args.find((a) => a.startsWith('--scope='));
    const params = new URLSearchParams({ format: 'text' });
    if (limitArg) params.set('limit', limitArg.slice('--limit='.length));
    if (scopeArg) params.set('scope', scopeArg.slice('--scope='.length));
    const res = await fetch(`${BASE}/api/v2/observability/trade-economic-attribution?${params}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 15_000)),
    });
    console.log(await res.text());
  },
  async 'daily-attribution'() {
    // 2026-09-14 (Institutional Transformation Mandate Part 21): real realized P&L by real
    // trading date + strategy id, organic PAPER only. Pass --since=YYYY-MM-DD to window.
    const sinceArg = process.argv.slice(3).find((a) => a.startsWith('--since='));
    const url = sinceArg
      ? `/api/v2/observability/daily-attribution?format=text&sinceDate=${encodeURIComponent(sinceArg.slice('--since='.length))}`
      : `/api/v2/observability/daily-attribution?format=text`;
    const res = await fetch(`${BASE}${url}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 15_000)),
    });
    console.log(await res.text());
  },
  async 'forecast'() {
    // 2026-09-13 (Institutional Transformation Mandate Part 7): builds and persists one real
    // forecast. Required: --agent=<name> --symbol=<SYM> --direction=BUY|SELL. Optional:
    // --strategyId=<id> --horizon=<label>.
    const args = process.argv.slice(3);
    const getArg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
    const agentName = getArg('agent');
    const symbol = getArg('symbol');
    const direction = getArg('direction');
    if (!agentName || !symbol || (direction !== 'BUY' && direction !== 'SELL')) {
      console.error('Usage: argus-cli forecast --agent=QuantEngine --symbol=AAPL --direction=BUY [--strategyId=MOMENTUM_BREAKOUT] [--horizon=1_BAR]');
      process.exitCode = 1;
      return;
    }
    const res = await fetch(`${BASE}/api/v2/observability/forecast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cliAuthHeaders() },
      body: JSON.stringify({ agentName, symbol, direction, strategyId: getArg('strategyId'), horizonLabel: getArg('horizon') }),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 15_000)),
    });
    console.log(await res.text());
  },
  async 'consensus-debate-health'() {
    // 2026-09-13 (ConsensusDebate P0.5 forensic measurement): real HOLD-veto good/bad
    // classification + net economic value. Pass --hours=N to window; omit for all-time.
    const hoursArg = process.argv.slice(3).find((a) => a.startsWith('--hours='));
    const url = hoursArg
      ? `/api/v2/observability/consensus-debate-health?format=text&hours=${encodeURIComponent(hoursArg.slice('--hours='.length))}`
      : `/api/v2/observability/consensus-debate-health?format=text`;
    const res = await fetch(`${BASE}${url}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'consensus-report'() {
    // Phase 9 (2026-08-27): the aggregated "why no trade" dashboard, built from real
    // CONSENSUS_TERMINAL_REASON rows + risk_assessments/trades/fills. Pass --hours=N to widen
    // the window (default 24).
    const hoursArg = process.argv.slice(3).find((a) => a.startsWith('--hours='));
    const hours = hoursArg ? hoursArg.slice('--hours='.length) : '24';
    const res = await fetch(`${BASE}/api/v2/observability/consensus-report?format=text&hours=${encodeURIComponent(hours)}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'risk-recent'() {
    // 2026-09-23 (operator-directed RiskEngine forensic) - real, existing, read-only route
    // (v2Runtime.ts's GET /risk/recent-assessments): every persisted risk_assessments row plus
    // its full risk_gate_results breakdown (every gate recorded even after the first failure, per
    // CLAUDE.md's own "every gate recorded" rule) - never a synthesized/assumed pass. Pass --limit=N.
    const limitArg = process.argv.slice(3).find((a) => a.startsWith('--limit='));
    const url = limitArg
      ? `/api/v2/runtime/risk/recent-assessments?limit=${encodeURIComponent(limitArg.slice('--limit='.length))}`
      : '/api/v2/runtime/risk/recent-assessments';
    console.log(JSON.stringify(await fetchJson(url), null, 2));
  },
  async 'trading-funnel'() {
    // Phase 9 (2026-08-31): the single authoritative trading-funnel dashboard - candidateLifecycle
    // state counts + consensusPipelineReport + providerHealthMatrix in one view. Pass --hours=N
    // to widen the consensus/risk/fill window (default 24); candidate counts are always "now".
    const hoursArg = process.argv.slice(3).find((a) => a.startsWith('--hours='));
    const hours = hoursArg ? hoursArg.slice('--hours='.length) : '24';
    const res = await fetch(`${BASE}/api/v2/observability/trading-funnel?format=text&hours=${encodeURIComponent(hours)}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'quant-evidence'() {
    // Milestone B.1 (2026-09-23): per-producer QuantEvidence observability view (JavaFactorComposite
    // / JavaCoreEnsemble) - count, latest direction/confidence/regime, % supported (REAL_VALUE/
    // DERIVED) vs unsupported (NULL_NOT_SUPPORTED/NOT_YET_CALIBRATED) fields, calibration state.
    // Pass --hours=N (default 24).
    const hoursArg = process.argv.slice(3).find((a) => a.startsWith('--hours='));
    const hours = hoursArg ? hoursArg.slice('--hours='.length) : '24';
    const res = await fetch(`${BASE}/api/v2/observability/quant-evidence?format=text&hours=${encodeURIComponent(hours)}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'portfolio-impact'() {
    // Phase 5 (ARGUS_MASTER_REDESIGN_PLAN.md "Portfolio Construction", 2026-09-27): read-only
    // candidate-impact report - CURRENT real portfolio + a hypothetical trade -> real
    // marginal-risk-contribution and minimum-variance-optimizer evidence from the Java quant core.
    // Advisory only, never places or sizes an order. Usage:
    //   argus-cli portfolio-impact --symbol=AAPL [--side=BUY] [--notional=1000] [--maxWeightPct=0.20] [--lookbackTradingDays=90]
    const args = process.argv.slice(3);
    const get = (flag: string) => args.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
    const symbol = get('symbol');
    if (!symbol) {
      console.error('Usage: argus-cli portfolio-impact --symbol=AAPL [--side=BUY|SELL] [--notional=1000] [--maxWeightPct=0.20] [--lookbackTradingDays=90]');
      process.exitCode = 1;
      return;
    }
    const params = new URLSearchParams({ format: 'text', symbol });
    for (const [flag, key] of [['side', 'side'], ['notional', 'notional'], ['maxWeightPct', 'maxWeightPct'], ['lookbackTradingDays', 'lookbackTradingDays']] as const) {
      const v = get(flag);
      if (v) params.set(key, v);
    }
    const res = await fetch(`${BASE}/api/v2/observability/portfolio-impact?${params.toString()}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 20_000)),
    });
    console.log(await res.text());
  },
  async 'calibration-drift'() {
    // Phase 6 (ARGUS_MASTER_REDESIGN_PLAN.md "Adaptive/Self-Improvement Design" +
    // "Observability", 2026-09-27): read-only recent-vs-prior calibration comparison per
    // (agent, bucket) - flags DRIFT_SUSPECTED_DEGRADED/IMPROVED when the two windows' 95% Wilson
    // intervals don't overlap, using already-existing prediction_outcomes data. Advisory only;
    // never writes agent_confidence_calibration or any live gate.
    const res = await fetch(`${BASE}/api/v2/observability/calibration-drift?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 20_000)),
    });
    console.log(await res.text());
  },
  async 'reflection-engine-health'() {
    // P1-A follow-up (2026-09-23): ReflectionEngine.ts's own inFlight-guard skipped-overlap count
    // plus per-cycle duration / rows-scanned / query-duration for its 3 full-table scans (trades,
    // agent_predictions, kronos_predictions). In-process ring only (this running engine's own
    // recent cycles) - not a historical/cross-restart query.
    const res = await fetch(`${BASE}/api/v2/observability/reflection-engine-health?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'extended-hours-spread'() {
    // 2026-09-23 (operator-directed follow-up to the TSLA gate-25 forensic pass): quote
    // availability / bid-ask completeness / stale-quote rate / gate-25 rejection-reason counts,
    // by symbol. Pass --hours=N (default 168 = 7 days).
    const hoursArg = process.argv.slice(3).find((a) => a.startsWith('--hours='));
    const hours = hoursArg ? hoursArg.slice('--hours='.length) : '168';
    const res = await fetch(`${BASE}/api/v2/observability/extended-hours-spread?format=text&hours=${encodeURIComponent(hours)}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'why-no-trade'() {
    // Phase 9 (2026-08-31): single-candidate explainer. Pass --symbol=NVDA to check a specific
    // symbol's most recent evaluation; omitted, shows the most recent evaluation of any symbol.
    const symbolArg = process.argv.slice(3).find((a) => a.startsWith('--symbol='));
    const symbol = symbolArg ? symbolArg.slice('--symbol='.length) : '';
    const qs = symbol ? `symbol=${encodeURIComponent(symbol)}&` : '';
    const res = await fetch(`${BASE}/api/v2/observability/why-no-trade?${qs}format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'calibration-maturity'() {
    // Phase 9 (2026-08-31): explicit UNVALIDATED/LEARNING/CALIBRATED/TRUSTED classification per
    // (agent, confidence bucket) - reuses only already-computed effective-N/Wilson-lower-bound data,
    // never gates a trade. See calibrationMaturity.ts's header for the exact state definitions.
    const res = await fetch(`${BASE}/api/v2/observability/calibration-maturity?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'agent-edge'() {
    // Phase 10 (2026-08-31, Agent Edge Discovery & Strategy Validation): decision-ready agent-edge/
    // strategy-edge/agent-combination/trading-eligibility report, built entirely from real
    // agent_predictions/prediction_outcomes/agent_performance_stats/calibration data.
    // Real, historically-growing tables (TechnicalAgent alone: ~55k rows) mean this report's
    // full-scan statistics (OOS/walk-forward validation especially, one full fetch per agent) can
    // meaningfully exceed the other, cheaper reports' default timeout - a real cost of doing this
    // rigorously rather than a hang. Defaults longer here; still overridable via the same env var.
    const res = await fetch(`${BASE}/api/v2/observability/agent-edge?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 60_000)),
    });
    console.log(await res.text());
  },
  async 'multi-horizon-outcomes'() {
    // 2026-09-12 (Research Memory Platform Phase 2): mean forward return / positive-return rate
    // per (agent, strategy, horizon), from real prediction_outcome_horizons rows.
    const res = await fetch(`${BASE}/api/v2/observability/multi-horizon-outcomes?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 30_000)),
    });
    console.log(await res.text());
  },
  async 'strategy-catalog'() {
    // 2026-09-11: every strategy id this codebase knows about (CORE + EXPERIMENTAL TS +
    // JAVA_RESEARCH), family, live-eligibility right now, Node/Java ownership, lifecycle status.
    const res = await fetch(`${BASE}/api/v2/observability/strategy-catalog?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 30_000)),
    });
    console.log(await res.text());
  },
  async 'strategy-readiness'() {
    // Phase 10 continuation (2026-08-31): strategy activation matrix + real per-strategy edge
    // status. Which CORE strategies are implemented/enabled/reachable, and what real graded
    // evidence exists for each (EV-backed vs. cold-start-bootstrap-sourced, never merged).
    const res = await fetch(`${BASE}/api/v2/observability/strategy-readiness?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 30_000)),
    });
    console.log(await res.text());
  },
  async 'strategy-fairness'() {
    // Phase 12 (2026-08-31): replays the REAL production selection code against real historical
    // quant_assessments rows, cross-referenced with real agent_predictions ground truth. Distinguishes
    // "evaluated but never selected" from "selected but never emitted" from "emitted but never graded".
    // Real, non-trivial computation over potentially tens of thousands of rows - long default timeout.
    const res = await fetch(`${BASE}/api/v2/observability/strategy-fairness?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 60_000)),
    });
    console.log(await res.text());
  },
  async 'strategy-recertification'() {
    // Strategy lifecycle re-certification review (2026-09-14, item #9 / mandate Phase 11). Real
    // gap closed: a RETIRED/DEGRADED strategy's evidence can drift materially with nothing ever
    // re-checking it. Review only - never auto-reinstates; see StrategyRecertification.ts's own
    // header for the full rationale.
    const res = await fetch(`${BASE}/api/v2/observability/strategy-recertification?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 30_000)),
    });
    console.log(await res.text());
  },
  async 'strategy-score-normalization-comparison'() {
    // Raw-vs-normalized strategy score comparison (2026-09-14, item #7 / mandate Phase 10).
    // Read-only research signal only - never flips the production flag. See
    // strategyScoreNormalizationComparison.ts's own header for the method and its honest limits.
    const res = await fetch(`${BASE}/api/v2/observability/strategy-score-normalization-comparison?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 60_000)),
    });
    console.log(await res.text());
  },
  async 'strategy-profitability'() {
    // Phase 13 (2026-08-31 real-edge audit): real net-P&L per strategy from real closed
    // round-trip fills - never estimated. Separate from strategy-fairness/strategy-readiness:
    // this answers "would trading this strategy have made money," not direction-correctness.
    // Pass --costProfile=Base|Conservative|Optimistic|... to change the CONFIGURED SIMULATION
    // ASSUMPTION applied on top of real fills (replaySafety.json) - default is replaySafety's own.
    const profileArg = process.argv.slice(3).find((a) => a.startsWith('--costProfile='));
    const qs = profileArg ? `&costProfile=${encodeURIComponent(profileArg.slice('--costProfile='.length))}` : '';
    const res = await fetch(`${BASE}/api/v2/observability/strategy-profitability?format=text${qs}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 30_000)),
    });
    console.log(await res.text());
  },
  async 'rescue-outcomes'() {
    // Phase 14 (2026-08-31): did a temporary market-data rescue grant actually lead to consensus,
    // RiskEngine, and a paper fill? Real correlation over already-persisted rows.
    const res = await fetch(`${BASE}/api/v2/observability/rescue-outcomes?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 30_000)),
    });
    console.log(await res.text());
  },
  async 'exploration-health'() {
    // Phase 18 (2026-09-01 rescue-fairness + exploration-observability mission): joins each
    // STRATEGY_EXPLORATION_PROMOTED promotion to rescue grant/denial, idea discard/emission,
    // consensus, RiskEngine, and OMS/fill outcomes by shared traceId - a Level 0-6 success ladder
    // per promotion. Read-only correlation over already-persisted rows.
    const res = await fetch(`${BASE}/api/v2/observability/exploration-health?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 30_000)),
    });
    console.log(await res.text());
  },
  async 'rescue-occupants'() {
    // Phase 18, Part 7: who currently holds a temporary-data-rescue slot, what class, since when,
    // how many times renewed. Live in-memory admission-state introspection, no secrets involved.
    const res = await fetch(`${BASE}/api/v2/observability/rescue-occupants?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'market-data-diagnostics'() {
    // 2026-09-20 (delayed-data observability follow-up): read-only live in-memory market-data
    // diagnostics - allocated/receiving/fresh/stale/error line counts plus per-symbol live quote,
    // delayed quote (bid/ask/last/close, each independently tracked), latest IBKR error, and
    // contract-resolution state. Never mutates any store. Optional --symbols=AAPL,MSFT filters to
    // specific symbols; omit for every currently-allocated symbol.
    const symbolsArg = process.argv.slice(3).find((a) => a.startsWith('--symbols='));
    const qs = symbolsArg ? `&symbols=${encodeURIComponent(symbolsArg.slice('--symbols='.length))}` : '';
    const res = await fetch(`${BASE}/api/v2/observability/market-data-diagnostics?format=text${qs}`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'ai-cost-governor'() {
    // Project A (2026-09-02): current policy, per-(agent,provider) real graded-outcome quality
    // ledger, and recent shadow-mode decisions. Off by default (config/aiCostGovernor.json);
    // never gates a trade.
    const res = await fetch(`${BASE}/api/v2/observability/ai-cost-governor?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'discovery-challengers'() {
    // 2026-09-30 (Discovery Challenger Observability Hardening, ARGUS_CHALLENGER_SELECTION_FORENSIC_
    // 2026-09-29.md follow-up): admission -> scoring -> truncation -> swap-budget -> promotion,
    // aggregated across the window. Read-only; never influences the real hot-swap decision.
    const hoursArg = process.argv.slice(3).find((a) => a.startsWith('--hours='));
    const hours = hoursArg ? hoursArg.slice('--hours='.length) : '24';
    const res = await fetch(`${BASE}/api/v2/observability/discovery-challengers?hours=${encodeURIComponent(hours)}&format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 30_000)),
    });
    console.log(await res.text());
  },
  async 'discovery-lineage'() {
    // Phase A (2026-09-02, forensic audit follow-up): per-symbol discovery admit/filter decision
    // plus how far it got through subscription/evaluation/consensus/risk/OMS. Requires --symbol=X;
    // optional --hours=N (default 24). Discovery-stage data only exists for activity after this
    // phase shipped - cannot retroactively explain an earlier miss.
    const symbolArg = process.argv.slice(3).find((a) => a.startsWith('--symbol='));
    const symbol = symbolArg ? symbolArg.slice('--symbol='.length) : '';
    if (!symbol) {
      console.error('Usage: argus-cli discovery-lineage --symbol=<SYMBOL> [--hours=24]');
      process.exitCode = 1;
      return;
    }
    const hoursArg = process.argv.slice(3).find((a) => a.startsWith('--hours='));
    const hours = hoursArg ? hoursArg.slice('--hours='.length) : '24';
    const res = await fetch(`${BASE}/api/v2/observability/discovery-lineage?symbol=${encodeURIComponent(symbol)}&hours=${encodeURIComponent(hours)}&format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    console.log(await res.text());
  },
  async 'strategy-scorecard'() {
    // Phase 14 (2026-08-31): complete 21-strategy scorecard - fairness + organic profitability +
    // lifecycle status, real data only. Does not itself run replay (a separate, long-running step).
    const res = await fetch(`${BASE}/api/v2/observability/strategy-scorecard?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 60_000)),
    });
    console.log(await res.text());
  },
  async 'pipeline-ready'() {
    // Zero-Trade Forensic Audit follow-up: distinguishes "process alive" from "trading pipeline
    // ready" (Process/Database/MarketData/Broker/Technical/Quant/AI Provider Layer, each
    // reported independently). Not evaluateLiveReadiness()/live-readiness - that stays the sole
    // LIVE-arming authority; this is a read-only PAPER/operational diagnostic.
    const res = await fetch(`${BASE}/api/v2/runtime/trading-readiness?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    console.log(text);
  },
  async 'session-report'() {
    // Pre-market/market-open operator observability (2026-08-24 readiness audit, Part 10) - real
    // counts only, scoped to the current trading day, organic PAPER/LIVE always reported separately
    // from REPLAY/BACKTEST/SIMULATION (see tradingSessionReport.ts's own header).
    const res = await fetch(`${BASE}/api/v2/runtime/trading-session-report?format=text`, {
      headers: cliAuthHeaders(),
      signal: AbortSignal.timeout(Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000)),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    console.log(text);
  },
  /**
   * Thin alias for 'session-report' (2026-08-25, quant-graduation/active-trading-readiness pass).
   * Phase 5 of that task asked for a `trading-audit` command answering "why didn't Argus trade" -
   * tradingSessionReport.ts already computes exactly that funnel (ideas generated/rejected,
   * missing-price, consensus rounds/approved/rejected, risk evaluations/approved, orders, fills),
   * scoped to the real current trading day from real event_traces/trades/risk_assessments rows.
   * This is intentionally NOT a second parallel report - same route, same renderer, same data -
   * only the command name differs, to avoid exactly the kind of silent-duplicate-implementation
   * this codebase's own rules warn against.
   */
  /**
   * Safe Research & Quant Intelligence Expansion (2026-08-25). Every subcommand hits
   * /api/v2/research-intelligence/* - a read-only research surface that cannot place orders,
   * bypass ChiefTrader, or touch RiskEngine/OMS/broker (architecture-test-enforced). Output is
   * always labeled RESEARCH/ADVISORY and never counted as live trading activity - see
   * session-report/trading-audit for that.
   */
  async research() {
    // `sub` intentionally reads raw argv (not cliArgs()) so `--help`/`-h` are still recognized as
    // the subcommand itself; only the positional args AFTER it are flag-filtered.
    const [sub, ...rest] = process.argv.slice(3);
    const restArgs = rest.filter((a) => !a.startsWith('--'));
    const usage = () => {
      console.log([
        'Usage: argus research <subcommand> [args]',
        '  audit                          List all 12 capabilities and their status',
        '  regime <SYMBOL>                Market regime detection',
        '  multi-factor <SYMBOL>          Multi-factor transparent scoring',
        '  trade-setup <SYMBOL>           Research-only trade setup (NOT an approved trade)',
        '  drawdown <SYMBOL>              Drawdown analysis on the real close-price series',
        '  correlation <SYM1,SYM2,...>    Pairwise correlation + diversification score',
        '  risk-reward <SYMBOL> <entry> <stop> <target> [strategyId]',
        '  macro                          Read-only macro bias (reuses MacroAgent\'s own cache)',
        '  strategy <universe csv> [timeframe] [targetRegime]',
        'All output is RESEARCH/ADVISORY only - never an executed trade.',
      ].join('\n'));
    };
    if (!sub || sub === '--help' || sub === '-h') { usage(); return; }
    const base = '/api/v2/research-intelligence';
    switch (sub) {
      case 'audit':
        console.log(JSON.stringify(await fetchJson(`${base}/audit`), null, 2));
        return;
      case 'regime':
        if (!restArgs[0]) return usage();
        console.log(JSON.stringify(await fetchJson(`${base}/regime`, { method: 'POST', body: JSON.stringify({ symbol: restArgs[0] }) }), null, 2));
        return;
      case 'multi-factor':
        if (!restArgs[0]) return usage();
        console.log(JSON.stringify(await fetchJson(`${base}/multi-factor`, { method: 'POST', body: JSON.stringify({ symbol: restArgs[0] }) }), null, 2));
        return;
      case 'trade-setup':
        if (!restArgs[0]) return usage();
        console.log(JSON.stringify(await fetchJson(`${base}/trade-setup`, { method: 'POST', body: JSON.stringify({ symbol: restArgs[0] }) }), null, 2));
        return;
      case 'drawdown':
        if (!restArgs[0]) return usage();
        console.log(JSON.stringify(await fetchJson(`${base}/drawdown`, { method: 'POST', body: JSON.stringify({ symbol: restArgs[0] }) }), null, 2));
        return;
      case 'correlation': {
        if (!restArgs[0]) return usage();
        const symbols = restArgs[0].split(',').map((s) => s.trim()).filter(Boolean);
        console.log(JSON.stringify(await fetchJson(`${base}/correlation`, { method: 'POST', body: JSON.stringify({ symbols }) }), null, 2));
        return;
      }
      case 'risk-reward': {
        const [symbol, entry, stop, target, strategyId] = restArgs;
        if (!symbol || entry === undefined || stop === undefined || target === undefined) return usage();
        console.log(JSON.stringify(await fetchJson(`${base}/risk-reward`, {
          method: 'POST',
          body: JSON.stringify({ symbol, entry: Number(entry), stop: Number(stop), target: Number(target), strategyId }),
        }), null, 2));
        return;
      }
      case 'macro':
        console.log(JSON.stringify(await fetchJson(`${base}/macro`), null, 2));
        return;
      case 'strategy': {
        if (!restArgs[0]) return usage();
        const universe = restArgs[0].split(',').map((s) => s.trim()).filter(Boolean);
        console.log(JSON.stringify(await fetchJson(`${base}/strategy-generation`, {
          method: 'POST',
          body: JSON.stringify({ universe, timeframe: restArgs[1], targetRegime: restArgs[2] }),
        }), null, 2));
        return;
      }
      default:
        usage();
    }
  },
  async 'trading-audit'() {
    return (commands as any)['session-report']();
  },
  /**
   * Phase 4A (Decision Funnel, 2026-08-26) - answers "what happened to THIS specific idea" end to
   * end, DISCOVERED through TRADE_CLOSED, without manual SQL. Wraps GET /api/v2/traces/:id/funnel.
   * Usage: argus funnel <traceId>
   */
  async funnel() {
    const traceId = cliArgs()[0];
    if (!traceId) {
      usageError('Usage: argus funnel <traceId>');
    }
    console.log(JSON.stringify(await fetchJson(`/api/v2/traces/${encodeURIComponent(traceId)}/funnel`), null, 2));
  },
  /**
   * Phase 4B (Evidence-Aware Consensus, SHADOW MODE ONLY, 2026-08-26) - shows legacy-vs-shadow
   * consensus divergence. The shadow model never influences a real trade; this is a validation
   * surface only, per Phase 4 Part 2's "do not replace the engine until runtime evidence supports
   * it" requirement. Usage: argus consensus-shadow [limit]
   */
  async 'consensus-shadow'() {
    const limit = cliArgs()[0] || '50';
    console.log(JSON.stringify(await fetchJson(`/api/v2/consensus/shadow-comparison?limit=${encodeURIComponent(limit)}`), null, 2));
  },
  /**
   * Phase 4C (Composable Candidate Ranking, 2026-08-26). Usage:
   *   argus ranking                 - latest full ranking cycle
   *   argus ranking <SYMBOL>        - one symbol's persisted ranking history across cycles
   */
  async ranking() {
    const arg = cliArgs()[0];
    if (!arg) {
      console.log(JSON.stringify(await fetchJson('/api/v2/continuous-intelligence/ranking/latest'), null, 2));
      return;
    }
    console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/ranking/history/${encodeURIComponent(arg)}`), null, 2));
  },
  /**
   * Phase 4D (Dynamic Subscription Priority Queue, 2026-08-26). Usage:
   *   argus subscription-queue           - current capacity/utilization snapshot
   *   argus subscription-queue decisions - recent promotion/eviction decisions with reasons
   */
  async 'subscription-queue'() {
    const sub = cliArgs()[0];
    if (sub === 'decisions') {
      console.log(JSON.stringify(await fetchJson('/api/v2/continuous-intelligence/subscription-decisions'), null, 2));
      return;
    }
    console.log(JSON.stringify(await fetchJson('/api/v2/continuous-intelligence/capacity'), null, 2));
  },
  /**
   * Phase 4E (Pre-Market TradePlan, 2026-08-27). Usage:
   *   argus trade-plan [YYYY-MM-DD]                 - all plans for that date (default: today)
   *   argus trade-plan [YYYY-MM-DD] <planId>         - revalidation history for one plan
   */
  async 'trade-plan'() {
    const [planDateArg, planId] = cliArgs();
    const planDate = planDateArg || new Date().toISOString().slice(0, 10);
    if (planId) {
      console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/trade-plans/${encodeURIComponent(planDate)}/${encodeURIComponent(planId)}/revalidations`), null, 2));
      return;
    }
    console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/trade-plans/${encodeURIComponent(planDate)}`), null, 2));
  },
  /**
   * Phase 4F (Missed Opportunity Intelligence, 2026-08-27). Usage:
   *   argus missed-opportunities [sinceMs]  - detected misses + classification breakdown
   *   (default lookback 24h if sinceMs omitted)
   */
  async 'missed-opportunities'() {
    const sinceMs = cliArgs()[0];
    const qs = sinceMs ? `?sinceMs=${encodeURIComponent(sinceMs)}` : '';
    console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/missed-opportunities${qs}`), null, 2));
  },
  /**
   * Phase 4G/4H (Learning + Champion/Challenger, 2026-08-27). Usage:
   *   argus learning observations [sinceMs]           - trust-level breakdown + recent rows
   *   argus learning versions <versionType>            - version history + current champion
   *   argus learning promotions <versionType> <versionId> - promotion-decision history for one version
   *   argus learning rollbacks <versionType>           - rollback event history
   */
  async learning() {
    const [sub, arg1, arg2] = cliArgs();
    if (sub === 'observations') {
      const sinceMs = arg1;
      const qs = sinceMs ? `?sinceMs=${encodeURIComponent(sinceMs)}` : '';
      console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/learning/observations${qs}`), null, 2));
      return;
    }
    if (sub === 'versions') {
      const versionType = arg1;
      console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/learning/versions/${encodeURIComponent(versionType)}`), null, 2));
      return;
    }
    if (sub === 'promotions') {
      const versionType = arg1;
      const versionId = arg2;
      console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/learning/versions/${encodeURIComponent(versionType)}/${encodeURIComponent(versionId)}/promotions`), null, 2));
      return;
    }
    if (sub === 'rollbacks') {
      const versionType = arg1;
      console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/learning/versions/${encodeURIComponent(versionType)}/rollbacks`), null, 2));
      return;
    }
    if (sub === 'calibration') {
      const calSub = arg1;
      if (calSub === 'worker-status') {
        console.log(JSON.stringify(await fetchJson('/api/v2/continuous-intelligence/learning/calibration/worker-status'), null, 2));
        return;
      }
      console.log(JSON.stringify(await fetchJson('/api/v2/continuous-intelligence/learning/calibration/candidates'), null, 2));
      return;
    }
    usageError('Usage: argus learning <observations|versions|promotions|rollbacks|calibration [worker-status]> [args...]');
  },
  /** Phase 4J (Session Lifecycle persistence, 2026-08-27). Current snapshot + recent persisted history. */
  async 'session-lifecycle'() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/session-lifecycle'), null, 2));
  },
  async config() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/config'), null, 2));
  },
  async 'paper-profile'() {
    const { paperAllocationProfile } = await import('./cli/paperAllocationProfile');
    const profile = JSON.parse(readFileSync(join(ROOT, 'config', 'paperAllocationProfile.json'), 'utf8'));
    console.log(JSON.stringify(await paperAllocationProfile(fetchJson, profile.budget, process.argv.includes('--apply')), null, 2));
  },
  async positions() {
    const data = await fetchJson('/api/v2/runtime/portfolio') as { portfolio?: any[] };
    if (isJsonOutput()) return printJson(data);
    printTable(data.portfolio ?? [], [
      { header: 'SYMBOL', pick: (r) => field(r, 'symbol') },
      { header: 'QTY', pick: (r) => field(r, 'quantity', 'qty', 'shares') },
      { header: 'AVG PRICE', pick: (r) => field(r, 'averageCost', 'avgPrice', 'average_price') },
      { header: 'MARKET VALUE', pick: (r) => field(r, 'marketValue', 'market_value') },
      { header: 'P&L', pick: (r) => field(r, 'unrealizedPnl', 'pnl', 'profitLoss') },
    ]);
  },
  async portfolio() {
    return commands.positions();
  },
  async orders() {
    const data = await fetchJson('/api/v2/runtime/orders') as { orders?: any[] };
    if (isJsonOutput()) return printJson(data);
    printTable(data.orders ?? [], [
      { header: 'ID', pick: (r) => field(r, 'orderId', 'id', 'clientOrderId').slice(0, 12) },
      { header: 'SYMBOL', pick: (r) => field(r, 'symbol') },
      { header: 'SIDE', pick: (r) => field(r, 'side') },
      { header: 'QTY', pick: (r) => field(r, 'quantity', 'qty', 'requestedQuantity') },
      { header: 'STATUS', pick: (r) => field(r, 'status') },
      { header: 'TIME', pick: (r) => field(r, 'createdAt', 'timestamp', 'submittedAt').slice(0, 19).replace('T', ' ') },
    ]);
  },
  async trades() {
    const data = await fetchJson('/api/v2/runtime/trades') as { trades?: any[] };
    if (isJsonOutput()) return printJson(data);
    printTable(data.trades ?? [], [
      { header: 'SYMBOL', pick: (r) => field(r, 'symbol') },
      { header: 'SIDE', pick: (r) => field(r, 'side') },
      { header: 'QTY', pick: (r) => field(r, 'quantity', 'qty', 'filledQuantity') },
      { header: 'PRICE', pick: (r) => field(r, 'price', 'averageFillPrice', 'fillPrice') },
      { header: 'TIME', pick: (r) => field(r, 'filledAt', 'timestamp', 'createdAt').slice(0, 19).replace('T', ' ') },
    ]);
  },
  async logs() {
    const data = await fetchJson('/api/v2/system/logs/recent?limit=50') as { logs?: any[] };
    if (isJsonOutput()) return printJson(data);
    printTable(data.logs ?? [], [
      { header: 'TIME', pick: (r) => field(r, 'ts', 'timestamp', 'createdAt').slice(0, 19).replace('T', ' ') },
      { header: 'LEVEL', pick: (r) => field(r, 'level') },
      { header: 'MESSAGE', pick: (r) => field(r, 'message', 'msg', 'event') },
    ]);
  },
  async enable() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/trading/enable', { method: 'POST', body: '{}' }), null, 2));
  },
  async disable() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/trading/disable', { method: 'POST', body: '{}' }), null, 2));
  },
  async 'kill-switch'() {
    // Safety: the emergency stop halts ALL trading immediately. It must never
    // fire from a typo or a stray keypress — require explicit --confirm.
    // (Industry standard for destructive one-shot commands: kubectl, terraform,
    // gh all gate destroys behind --force/--confirm or interactive prompts.)
    const args = process.argv.slice(3);
    const reasonArg = args.find((a) => a.startsWith('--reason='));
    const reason = reasonArg ? reasonArg.slice('--reason='.length) : 'CLI emergency stop';
    if (!args.includes('--confirm')) {
      usageError(
        'Refusing to trigger the emergency stop without explicit confirmation.\n' +
        'This halts ALL trading immediately. To proceed, run:\n' +
        '  argus kill-switch --confirm [--reason="why"]',
      );
    }
    console.log(JSON.stringify(await fetchJson('/api/v1/system/emergency-stop', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }), null, 2));
  },
  async agents() {
    const data = await fetchJson('/api/v1/system/pipeline-agents') as { togglable?: any[]; agents?: any[] };
    if (isJsonOutput()) return printJson(data);
    printTable(data.togglable ?? data.agents ?? [], [
      { header: 'ID', pick: (r) => field(r, 'id') },
      { header: 'LABEL', pick: (r) => field(r, 'label', 'name') },
      { header: 'ENABLED', pick: (r) => (r.enabled ? 'yes' : 'no') },
      { header: 'STATE', pick: (r) => field(r, 'currentState', 'state', 'status') },
      { header: 'HEALTHY', pick: (r) => (r.healthy ? 'yes' : r.healthy === false ? 'no' : '-') },
    ]);
  },
  async events() {
    const data = await fetchJson('/api/v2/system/events?limit=50') as { events?: any[] };
    if (isJsonOutput()) return printJson(data);
    printTable(data.events ?? [], [
      { header: 'TIME', pick: (r) => field(r, 'ts', 'timestamp', 'createdAt').slice(0, 19).replace('T', ' ') },
      { header: 'TYPE', pick: (r) => field(r, 'eventType', 'type', 'event') },
      { header: 'DETAIL', pick: (r) => field(r, 'message', 'detail', 'summary', 'component') },
    ]);
  },
  async risk() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/risk/status'), null, 2));
  },
  async 'quant-core'() {
    const health = await fetchJson('/api/v2/quant-core/health') as {
      enabled: boolean; connected: boolean; checkedAt: string; detail?: string;
    };
    const label = !health.enabled ? 'DISABLED (QUANT_JAVA_CORE_ENABLED=false)' : health.connected ? 'CONNECTED' : 'DISCONNECTED';
    console.log(`Java Quant Core: ${label}`);
    console.log(`Checked at: ${health.checkedAt}`);
    if (health.detail) console.log(`Detail: ${health.detail}`);
    console.log('');
    console.log(JSON.stringify(health, null, 2));
  },
  async parity() {
    const result = await fetchJson('/api/v2/quant-core/parity?limit=25') as {
      count: number;
      divergences: Array<{ ts: string; symbol: string | null; divergences: Array<{ field: string; tsValue: number; javaValue: number; diffPct: number }> }>;
    };
    console.log(`Recent shadow-parity divergences: ${result.count}`);
    if (result.count === 0) {
      console.log('(none recorded — either QUANT_JAVA_CORE_ENABLED is off, or no divergence >0.01% has occurred yet)');
      return;
    }
    console.log('');
    console.log('TIMESTAMP                SYMBOL   FIELD        TS_VALUE      JAVA_VALUE    DIFF%');
    for (const row of result.divergences) {
      for (const d of row.divergences) {
        console.log(
          `${row.ts.padEnd(25)} ${String(row.symbol ?? '-').padEnd(8)} ${d.field.padEnd(12)} ` +
          `${d.tsValue.toFixed(4).padEnd(13)} ${d.javaValue.toFixed(4).padEnd(13)} ${(d.diffPct * 100).toFixed(3)}%`,
        );
      }
    }
  },
  async discovery() {
    const status = await fetchJson('/api/v2/continuous-intelligence/status') as {
      opportunityLoopEnabled: boolean;
      opportunityIdeasEnabled: boolean;
      activeSymbols: string[];
      activeSlots: { used: number; max: number } | number;
      lastScan: { scannedCount: number; topMovers: string[]; timestamp: string | null };
      candidates: unknown[];
      maxActiveSubscriptions: number;
    };
    console.log(`Opportunity loop enabled: ${status.opportunityLoopEnabled} · ideas (voting) enabled: ${status.opportunityIdeasEnabled}`);
    console.log(`Last scan: ${status.lastScan.scannedCount} scanned, top movers: ${status.lastScan.topMovers.join(', ') || '(none)'} (${status.lastScan.timestamp ?? 'never'})`);
    console.log(`Shortlisted candidates (watchlist-subscribe only — never a second order path): ${status.candidates.length}`);
    console.log(`Active MarketDataWorker subscriptions: ${status.activeSymbols.length} (cap: ${status.maxActiveSubscriptions})`);
    console.log('');
    console.log(JSON.stringify(status, null, 2));
  },
  async campaign() {
    const status = await fetchJson('/api/v2/campaign/status') as {
      enabled: boolean; badge: string; progress: number; targetDollars: number;
      dailyRealized: number; dailyUnrealized: number; dailyTotal: number; buyLocked: boolean;
      targetAchievedAction: string;
    };
    if (!status.enabled) {
      console.log('Daily Goal Campaign: DISABLED (settings.campaignEnabled is false)');
      return;
    }
    console.log(`Daily Goal Campaign: ${status.badge} (${(status.progress * 100).toFixed(1)}% of $${status.targetDollars})`);
    console.log(`Realized: $${status.dailyRealized.toFixed(2)} · Unrealized: $${status.dailyUnrealized.toFixed(2)} · Total: $${status.dailyTotal.toFixed(2)}`);
    console.log(`BUY soft-lock: ${status.buyLocked} · policy: ${status.targetAchievedAction}`);
    console.log('');
    console.log(JSON.stringify(status, null, 2));
  },
  async replay() {
    const sub = cliArgs()[0];
    if (!sub || sub === 'run') return replayCommands.run();
    if (sub === 'help' || sub === '--help' || sub === '-h') {
      console.log([
        'Usage: argus replay <subcommand> [args]',
        '  list                      List historical evaluation runs',
        '  run [--engine=node|java] [--universe=discovery|symbols|operator] [--symbols=AAPL,MSFT]',
        '      [--capital=100000] [--start=2024-01-02] [--end=2024-12-31] [--provider=golden_replay]',
        '                            Run a historical evaluation (MODE B)',
        '  report <runId>            Show the evaluation report',
        '  export <runId>            Export run artifacts',
        '  analyze <runId>           Analyze a completed run',
        '  diagnostics <runId>       Run diagnostics on a run',
      ].join('\n'));
      return;
    }
    const handler = replayCommands[sub];
    if (!handler) usageError(`Unknown replay subcommand: ${sub}\nRun 'argus replay help' for the subcommand list.`);
    return handler();
  },
  /**
   * Phase 4I (Professional CLI, partial - 2026-08-27). Groups commands by concern for
   * discoverability. This is a documentation aid over the existing flat dispatch table, not a
   * command-hierarchy rewrite - every name below still works exactly as a top-level `argus <name>`
   * invocation.
   */
  /**
   * doctor — environment + API health checks in the `brew doctor` tradition.
   * Lets a headless operator (no browser UI) verify the machine is fit to run
   * Argus. Pure Node (no bash), so it works on Windows too — unlike ./argus doctor.
   * Exit 0: no critical failures. Exit 1: at least one critical failure.
   */
  async doctor() {
    const { execFileSync } = await import('node:child_process');
    let crit = 0;
    let warn = 0;
    const ok = (msg: string) => console.log(`PASS  ${msg}`);
    const bad = (msg: string) => { console.log(`FAIL  ${msg}`); crit++; };
    const meh = (msg: string) => { console.log(`WARN  ${msg}`); warn++; };
    console.log('ARGUS DOCTOR');
    console.log('');

    // Runtime
    try {
      const v = execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim();
      ok(`node ${v}`);
    } catch { bad('node is not runnable'); }
    try {
      execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: 'pipe' });
      ok('npm available');
    } catch { bad('npm missing'); }

    // Repo layout
    if (existsSync(join(ROOT, 'node_modules'))) ok('dependencies installed (node_modules present)');
    else bad('dependencies missing (run npm install / npm ci)');
    if (existsSync(join(ROOT, '.env'))) ok('.env present (values never printed)');
    else meh('.env not found (copy from .env.example)');
    if (existsSync(join(ROOT, 'dist', 'server.cjs'))) ok('production build present (dist/server.cjs)');
    else meh('production build missing (optional for dev/tsx mode)');

    // API reachability (short probe, never the full 20s CLI timeout)
    try {
      const probe = await fetch(`${apiBase()}/api/v2/runtime/health`, {
        signal: AbortSignal.timeout(3000),
        headers: cliAuthHeaders(),
      });
      if (probe.ok) ok(`API reachable at ${apiBase()} (runtime health OK)`);
      else if (probe.status === 401 || probe.status === 403) meh(`API reachable but requires auth (run: argus login)`);
      else meh(`API answered HTTP ${probe.status} on health probe`);
    } catch {
      meh(`API not reachable at ${apiBase()} (engine may be stopped — see: argus wait-ready)`);
    }

    // Engine pid file
    const pidFile = join(ROOT, 'data', '.argus_engine.pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* not alive */ }
      if (pid > 0 && alive) ok(`engine PID file valid (pid ${pid} alive)`);
      else meh('engine PID file stale (process not running)');
    } else {
      meh('no engine PID file (engine not started via CLI)');
    }

    // CLI session
    if (existsSync(SESSION_PATH)) ok(`CLI session file present (${SESSION_PATH})`);
    else meh('no CLI session file (run: argus login)');

    console.log('');
    console.log(`doctor: ${crit} critical, ${warn} warnings`);
    if (crit > 0) process.exitCode = 1;
  },
  /**
   * Print a shell completion script for argus-cli command names.
   * Install: `argus completion bash >> ~/.bashrc` (or `zsh >> ~/.zshrc`).
   */
  async completion() {
    const shell = (cliArgs()[0] || 'bash').toLowerCase();
    const names = Object.keys(commands).sort().join(' ');
    if (shell === 'zsh') {
      console.log([
        '#compdef argus',
        '_argus() {',
        '  local -a cmds',
        `  cmds=(${Object.keys(commands).sort().join(' ')})`,
        '  _describe "argus commands" cmds',
        '}',
        'compdef _argus argus',
      ].join('\n'));
      return;
    }
    // bash (default)
    console.log([
      '# argus-cli bash completion: argus completion bash >> ~/.bashrc',
      '_argus_complete() {',
      '  local cur="${COMP_WORDS[COMP_CWORD]}"',
      `  COMPREPLY=($(compgen -W "${names}" -- "$cur"))`,
      '}',
      'complete -F _argus_complete argus',
    ].join('\n'));
  },
  async help() {
    console.log('Argus CLI - HTTP client only. Never imports RiskEngine/OMS/BrokerManager directly.\n');
    console.log('Global flags (before or after the command):');
    console.log('  --json            Print raw JSON instead of human-readable tables');
    console.log('  --api-url=<url>    Override the API base (default http://127.0.0.1:3000)');
    console.log('  -h, --help        Show help (global or per-command: argus <cmd> --help)');
    console.log('');
    const groups: Array<[string, string[]]> = [
      ['System / lifecycle', ['status', 'health', 'start', 'stop', 'restart', 'wait-ready', 'config']],
      ['Watchdog (detached auto-restart supervisor)', ['watchdog-start', 'watchdog-stop', 'watchdog-restart', 'watchdog-status']],
      ['Trading state / portfolio', ['resume', 'pause', 'ready', 'positions', 'portfolio', 'brokers', 'set-broker', 'paper-profile']],
      ['Discovery / ranking (Phase 4C-4F)', ['ranking', 'subscription-queue', 'trade-plan', 'missed-opportunities']],
      ['Learning / self-evolution (Phase 4G-4H)', ['learning']],
      ['Session lifecycle (Phase 4J)', ['session-lifecycle']],
      ['Consensus / funnel observability', ['funnel', 'consensus-shadow', 'consensus-report', 'consensus-debate-health', 'opportunity-snapshot', 'execution-quality', 'trade-economic-attribution', 'forecast', 'daily-attribution', 'provider-health', 'trading-funnel', 'why-no-trade', 'calibration-maturity', 'agent-edge', 'multi-horizon-outcomes', 'strategy-catalog', 'strategy-readiness', 'strategy-fairness', 'strategy-recertification', 'strategy-score-normalization-comparison', 'strategy-profitability', 'rescue-outcomes', 'exploration-health', 'rescue-occupants', 'ai-cost-governor', 'discovery-lineage', 'discovery-challengers', 'strategy-scorecard', 'market-data-diagnostics', 'quant-evidence', 'reflection-engine-health', 'portfolio-impact']],
      ['Campaign', ['campaign']],
      ['Replay (Historical Evaluation, MODE B)', ['replay']],
      ['Doctor & shell integration', ['doctor', 'completion']],
    ];
    for (const [label, names] of groups) {
      const present = names.filter((n) => n in commands);
      if (present.length > 0) console.log(`${label}:\n  ${present.join(', ')}\n`);
    }
    const grouped = new Set(groups.flatMap(([, names]) => names));
    const ungrouped = Object.keys(commands).filter((c) => !grouped.has(c) && c !== 'help');
    if (ungrouped.length > 0) console.log(`Other:\n  ${ungrouped.join(', ')}\n`);
  },
};

/** All registered command names — used by completion, help coverage tests, etc. */
export function commandNames(): string[] {
  return Object.keys(commands);
}

// Real bug found and fixed (2026-09-04, exposed by argus-cli.spawn.test.ts - the first test ever
// to import this file as a module rather than only running it as a script): this dispatch used to
// run unconditionally at module load, with no guard distinguishing "invoked as `tsx argus-cli.ts
// <command>`" from "imported for its exported pure functions". A test importing anything from this
// file therefore also executed this entire block as a side effect - parsing argv, potentially
// calling commands[], and reaching a real process.exit(1) (vitest intercepts it rather than
// actually killing the worker, but it still surfaced as an unhandled-rejection warning: "This
// might cause false positive tests"). Guarded the same way a CommonJS `require.main === module`
// check would: only run when this file is the actual entry point Node was invoked with.
const isMainModule = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const rawArgs = process.argv.slice(2);
  // Global flags (accepted before or after the command name).
  const apiUrlFlag = rawArgs.find((a) => a.startsWith('--api-url='));
  if (apiUrlFlag) setApiBaseOverride(apiUrlFlag.slice('--api-url='.length));
  if (rawArgs.includes('--json')) setJsonOutput(true);

  const cmd = rawArgs.find((a) => !a.startsWith('--')) || 'status';
  const onlyFlags = !rawArgs.some((a) => !a.startsWith('--'));
  if (onlyFlags) {
    // `argus --help` / `argus --version` with no command name.
    if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
      await commands.help();
      process.exit(0);
    }
    if (rawArgs.includes('--version') || rawArgs.includes('-v')) {
      await commands.version();
      process.exit(0);
    }
    // Otherwise fall through to the default command (status).
  }
  if (!commands[cmd]) {
    console.error(`Unknown command: ${cmd}`);
    const suggestions = suggestCommands(cmd, Object.keys(commands));
    if (suggestions.length > 0) {
      console.error(`Did you mean: ${suggestions.join(', ')}?`);
    }
    console.error(`Run "argus help" for a categorized list.`);
    process.exit(1);
  }

  // Per-command help: `argus <cmd> --help`. Commands with richer native help
  // (research, replay) handle --help themselves and are excluded here.
  const rest = process.argv.slice(3);
  if ((rest.includes('--help') || rest.includes('-h')) && cmd !== 'research' && cmd !== 'replay') {
    const entry = COMMAND_HELP[cmd];
    if (entry) {
      console.log(entry);
      process.exit(0);
    }
  }

  commands[cmd]().catch((e) => {
    console.error(e.message || e);
    const code = e && typeof e === 'object' && 'exitCode' in e && typeof (e as { exitCode: unknown }).exitCode === 'number'
      ? (e as { exitCode: number }).exitCode
      : 1;
    process.exit(code);
  });
}
