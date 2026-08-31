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

const BASE = process.env.ARGUS_API_URL || 'http://127.0.0.1:3000';
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

function cliAuthHeaders(): Record<string, string> {
  return buildCliAuthHeaders({ sessionPath: SESSION_PATH });
}

async function fetchJson(path: string, init?: RequestInit) {
  const timeoutMs = Number(process.env.ARGUS_CLI_FETCH_TIMEOUT_MS || 10_000);
  const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...cliAuthHeaders(),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
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
 * DEF-26 support: poll until nothing answers /health, confirming a graceful shutdown request
 * actually completed rather than assuming a fixed delay was long enough (the previous restart()
 * used a blind 1500ms setTimeout with no confirmation at all).
 */
async function waitForHealthGone(timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pid = await currentlyAnsweringPid();
    if (pid === undefined) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Best-effort read of whatever pid is currently answering /health, before a start/restart. */
async function currentlyAnsweringPid(): Promise<number | undefined> {
  try {
    const h = await fetchJson('/api/v2/runtime/health') as { ok?: boolean; health?: { pid?: number } };
    return h.ok ? h.health?.pid : undefined;
  } catch {
    return undefined;
  }
}

function parseFlags(argv: string[]) {
  return {
    headless: argv.includes('--headless') || argv.includes('-H'),
    prod: argv.includes('--prod'),
    dev: argv.includes('--dev'),
  };
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
  const staleAnsweringPid = await currentlyAnsweringPid();
  const env = { ...process.env, ARGUS_HEADLESS: 'true', ARGUS_ENGINE: 'true' };
  let child;
  if (useProd) {
    child = spawn(process.execPath, [join(ROOT, 'scripts', 'argus-engine-prod.mjs')], { cwd: ROOT, env, detached: true, stdio: 'ignore' });
  } else {
    const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    child = spawn(process.execPath, [tsx, join(ROOT, 'scripts', 'argus-engine.ts')], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: 'ignore',
    });
  }
  if (!child.pid) throw new Error('Failed to spawn Argus engine process');
  writeEnginePid(child.pid);
  child.unref();
  const ready = await waitForHealth(60_000, staleAnsweringPid);
  let message = ready ? 'Engine started' : 'Engine spawned but health check timed out';
  let reportedPid = child.pid;
  if (!ready && staleAnsweringPid !== undefined) {
    // Distinguish "nothing ever answered" from "the same stale process from before this start
    // attempt is still answering on this port" - the second case needs a manual investigation
    // (find and stop the real listener), not a retry of the same start command.
    message = `Engine spawn requested but pid ${staleAnsweringPid} (already answering on ${BASE} before this start attempt) is still the one responding - the new process did not take over the port. Stop pid ${staleAnsweringPid} manually, then retry.`;
  }
  if (ready && !useProd) {
    // Real bug found and fixed (2026-08-25, same pass as the pid-collision fix above): in --dev
    // mode `child` is only the tsx CLI wrapper (node_modules/tsx/dist/cli.mjs), which itself
    // forks a separate child process to actually run scripts/argus-engine.ts and bind the port -
    // confirmed live this session (two distinct node.exe processes, wrapper -> real engine,
    // different PIDs). Recording the wrapper's pid in the pid file meant stopEngine()'s
    // isPidAlive() check could go stale as soon as the wrapper itself exited, even while the real
    // engine (the child) was still healthy and serving - repeatedly observed this session as
    // "stop"/"restart" reporting 'No engine PID file' or refusing to signal, while a real engine
    // process kept running unmanaged. Now reconciles the pid file to whatever /health itself
    // reports as the actual serving process's pid once it's confirmed ready.
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
    if (!id) throw new Error('Usage: argus replay report <runId>');
    console.log(JSON.stringify(await fetchJson(`/api/v2/historical-evaluations/${id}/report`), null, 2));
  },
  async export() {
    const id = parseReplayArgs(process.argv.slice(4)).runId;
    if (!id) throw new Error('Usage: argus replay export <runId>');
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
    if (!id) throw new Error('Usage: argus replay analyze <runId>');
    const report = await fetchJson(`/api/v2/historical-evaluations/${id}/report`);
    console.log(JSON.stringify({
      mode: 'historical_evaluation_analyze',
      note: 'Exposes existing report evidence only. Does not auto-tune risk, consensus, or weights.',
      report,
    }, null, 2));
  },
  async diagnostics() {
    const id = parseReplayArgs(process.argv.slice(4)).runId;
    if (!id) throw new Error('Usage: argus replay diagnostics <runId>');
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

const commands: Record<string, () => Promise<void>> = {
  async version() {
    let version = '0.0.0';
    try {
      version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? version;
    } catch {
      /* ignore */
    }
    console.log(JSON.stringify({
      ok: true,
      name: 'argus-cli',
      version,
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
  async status() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/status'), null, 2));
  },
  async health() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/health'), null, 2));
    const qc = await fetchJson('/api/v2/quant-core/health') as { enabled: boolean; connected: boolean; detail?: string };
    const label = !qc.enabled ? 'DISABLED' : qc.connected ? 'CONNECTED' : 'DISCONNECTED';
    console.log(`QuantCoreBridge: ${label}${qc.detail ? ` (${qc.detail})` : ''}`);
  },
  async ready() {
    console.log(JSON.stringify(await fetchJson('/api/v2/live-readiness'), null, 2));
  },
  async 'provider-health'() {
    // Phase 9 (2026-08-27): real per-provider health matrix - DB aggregates + AIRouter's live
    // routing snapshot, never a new live probe burning real provider quota just for this report.
    console.log(JSON.stringify(await fetchJson('/api/v2/observability/provider-health-matrix'), null, 2));
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
    const [sub, ...rest] = process.argv.slice(3);
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
        if (!rest[0]) return usage();
        console.log(JSON.stringify(await fetchJson(`${base}/regime`, { method: 'POST', body: JSON.stringify({ symbol: rest[0] }) }), null, 2));
        return;
      case 'multi-factor':
        if (!rest[0]) return usage();
        console.log(JSON.stringify(await fetchJson(`${base}/multi-factor`, { method: 'POST', body: JSON.stringify({ symbol: rest[0] }) }), null, 2));
        return;
      case 'trade-setup':
        if (!rest[0]) return usage();
        console.log(JSON.stringify(await fetchJson(`${base}/trade-setup`, { method: 'POST', body: JSON.stringify({ symbol: rest[0] }) }), null, 2));
        return;
      case 'drawdown':
        if (!rest[0]) return usage();
        console.log(JSON.stringify(await fetchJson(`${base}/drawdown`, { method: 'POST', body: JSON.stringify({ symbol: rest[0] }) }), null, 2));
        return;
      case 'correlation': {
        if (!rest[0]) return usage();
        const symbols = rest[0].split(',').map((s) => s.trim()).filter(Boolean);
        console.log(JSON.stringify(await fetchJson(`${base}/correlation`, { method: 'POST', body: JSON.stringify({ symbols }) }), null, 2));
        return;
      }
      case 'risk-reward': {
        const [symbol, entry, stop, target, strategyId] = rest;
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
        if (!rest[0]) return usage();
        const universe = rest[0].split(',').map((s) => s.trim()).filter(Boolean);
        console.log(JSON.stringify(await fetchJson(`${base}/strategy-generation`, {
          method: 'POST',
          body: JSON.stringify({ universe, timeframe: rest[1], targetRegime: rest[2] }),
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
    const traceId = process.argv[3];
    if (!traceId) {
      console.log('Usage: argus funnel <traceId>');
      return;
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
    const limit = process.argv[3] || '50';
    console.log(JSON.stringify(await fetchJson(`/api/v2/consensus/shadow-comparison?limit=${encodeURIComponent(limit)}`), null, 2));
  },
  /**
   * Phase 4C (Composable Candidate Ranking, 2026-08-26). Usage:
   *   argus ranking                 - latest full ranking cycle
   *   argus ranking <SYMBOL>        - one symbol's persisted ranking history across cycles
   */
  async ranking() {
    const arg = process.argv[3];
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
    const sub = process.argv[3];
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
    const planDate = process.argv[3] || new Date().toISOString().slice(0, 10);
    const planId = process.argv[4];
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
    const sinceMs = process.argv[3];
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
    const sub = process.argv[3];
    if (sub === 'observations') {
      const sinceMs = process.argv[4];
      const qs = sinceMs ? `?sinceMs=${encodeURIComponent(sinceMs)}` : '';
      console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/learning/observations${qs}`), null, 2));
      return;
    }
    if (sub === 'versions') {
      const versionType = process.argv[4];
      console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/learning/versions/${encodeURIComponent(versionType)}`), null, 2));
      return;
    }
    if (sub === 'promotions') {
      const versionType = process.argv[4];
      const versionId = process.argv[5];
      console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/learning/versions/${encodeURIComponent(versionType)}/${encodeURIComponent(versionId)}/promotions`), null, 2));
      return;
    }
    if (sub === 'rollbacks') {
      const versionType = process.argv[4];
      console.log(JSON.stringify(await fetchJson(`/api/v2/continuous-intelligence/learning/versions/${encodeURIComponent(versionType)}/rollbacks`), null, 2));
      return;
    }
    if (sub === 'calibration') {
      const calSub = process.argv[4];
      if (calSub === 'worker-status') {
        console.log(JSON.stringify(await fetchJson('/api/v2/continuous-intelligence/learning/calibration/worker-status'), null, 2));
        return;
      }
      console.log(JSON.stringify(await fetchJson('/api/v2/continuous-intelligence/learning/calibration/candidates'), null, 2));
      return;
    }
    console.log('Usage: argus learning <observations|versions|promotions|rollbacks|calibration [worker-status]> [args...]');
  },
  /** Phase 4J (Session Lifecycle persistence, 2026-08-27). Current snapshot + recent persisted history. */
  async 'session-lifecycle'() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/session-lifecycle'), null, 2));
  },
  async config() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/config'), null, 2));
  },
  async positions() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/portfolio'), null, 2));
  },
  async portfolio() {
    return commands.positions();
  },
  async orders() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/orders'), null, 2));
  },
  async trades() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/trades'), null, 2));
  },
  async logs() {
    console.log(JSON.stringify(await fetchJson('/api/v2/system/logs/recent?limit=50'), null, 2));
  },
  async enable() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/trading/enable', { method: 'POST', body: '{}' }), null, 2));
  },
  async disable() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/trading/disable', { method: 'POST', body: '{}' }), null, 2));
  },
  async 'kill-switch'() {
    console.log(JSON.stringify(await fetchJson('/api/v1/system/emergency-stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'CLI emergency stop' }),
    }), null, 2));
  },
  async agents() {
    console.log(JSON.stringify(await fetchJson('/api/v1/system/pipeline-agents'), null, 2));
  },
  async events() {
    console.log(JSON.stringify(await fetchJson('/api/v2/system/events?limit=50'), null, 2));
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
    const sub = process.argv[3];
    if (!sub || sub === 'run' || sub.startsWith('--')) return replayCommands.run();
    const handler = replayCommands[sub];
    if (!handler) throw new Error(`Unknown replay subcommand: ${sub}`);
    return handler();
  },
  /**
   * Phase 4I (Professional CLI, partial - 2026-08-27). Groups commands by concern for
   * discoverability. This is a documentation aid over the existing flat dispatch table, not a
   * command-hierarchy rewrite - every name below still works exactly as a top-level `argus <name>`
   * invocation.
   */
  async help() {
    console.log('Argus CLI - HTTP client only. Never imports RiskEngine/OMS/BrokerManager directly.\n');
    const groups: Array<[string, string[]]> = [
      ['System / lifecycle', ['status', 'health', 'start', 'stop', 'restart', 'config']],
      ['Trading state / portfolio', ['positions', 'portfolio']],
      ['Discovery / ranking (Phase 4C-4F)', ['ranking', 'subscription-queue', 'trade-plan', 'missed-opportunities']],
      ['Learning / self-evolution (Phase 4G-4H)', ['learning']],
      ['Session lifecycle (Phase 4J)', ['session-lifecycle']],
      ['Consensus / funnel observability', ['funnel', 'consensus-shadow', 'consensus-report', 'provider-health', 'trading-funnel', 'why-no-trade', 'calibration-maturity']],
      ['Campaign', ['campaign']],
      ['Replay (Historical Evaluation, MODE B)', ['replay']],
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

const cmd = process.argv[2] || 'status';
if (cmd === '--help' || cmd === '-h') {
  await commands.help();
  process.exit(0);
}
if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Available: ${Object.keys(commands).join(', ')}`);
  console.error(`Run "argus help" for a categorized list.`);
  process.exit(1);
}

commands[cmd]().catch((e) => {
  console.error(e.message || e);
  if (e instanceof AuthRequiredError || (e && typeof e === 'object' && 'exitCode' in e && (e as { exitCode: number }).exitCode === EXIT_AUTH)) {
    process.exit(EXIT_AUTH);
  }
  process.exit(1);
});
