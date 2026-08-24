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

async function waitForHealth(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const h = await fetchJson('/api/v2/runtime/health') as { ok?: boolean };
      if (h.ok) return true;
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
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
  const ready = await waitForHealth();
  console.log(JSON.stringify({
    ok: ready,
    pid: child.pid,
    headless: true,
    api: BASE,
    message: ready ? 'Engine started' : 'Engine spawned but health check timed out',
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
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e: unknown) {
    clearEnginePid();
    throw e;
  }
  clearEnginePid();
  console.log(JSON.stringify({ ok: true, message: 'SIGTERM sent', pid }, null, 2));
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
    await stopEngine().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
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
};

const cmd = process.argv[2] || 'status';
if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

commands[cmd]().catch((e) => {
  console.error(e.message || e);
  if (e instanceof AuthRequiredError || (e && typeof e === 'object' && 'exitCode' in e && (e as { exitCode: number }).exitCode === EXIT_AUTH)) {
    process.exit(EXIT_AUTH);
  }
  process.exit(1);
});
