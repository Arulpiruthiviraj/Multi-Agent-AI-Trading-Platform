/**
 * Prints ecosystem service health in the same shape as ModelRuntimeManager / OrchestrationStatus.
 * Used by argus.sh after start|restart|stop|nuke and for `./argus.sh status`.
 * Probes real endpoints only — never fabricates READY.
 */
import 'dotenv/config';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  GUARDIAN_MCP_URL,
  mcpEndpointIsOpenAlice,
  openAliceSkipReason,
  shouldSkipOpenAlice,
} from './openAliceDevSupport';

/**
 * CLI/control-plane startup-semantics hardening (2026-09-23, operator-directed, real reproduced
 * bug: `./argus.sh start`/`restart` reported Argus AND every companion as FAILED after the fixed
 * 90s window, even though the real engine (and Vite, mounted as Express middleware on the SAME
 * port - see below) went on to boot successfully seconds later). Root cause was two-fold, both
 * fixed here: (1) companion probes (Ollama/Chronos/OpenAlice/Java Quant Core) had no STARTING
 * state at all - unlike probeArgus() below, which already distinguished "port open, health not
 * yet ready" from "nothing listening" - so a companion genuinely still loading (Chronos's own
 * documented first-model-load time, for example) reported FAILED with zero distinction from a
 * real, permanent failure. (2) FAILED was decided purely from a fixed probe-timeout window with no
 * awareness of how long the ecosystem has actually been booting - a service given 90s when its own
 * real, documented startup budget is up to 180s (devWithOpenAlice.ts's Chronos/OpenAlice waits) was
 * always going to read FAILED at that exact moment, regardless of the timeout value chosen. Per
 * the operator's own explicit instruction, simply raising a number was rejected as a real fix -
 * `--boot-elapsed-seconds` below makes the classification genuinely time-aware instead.
 *
 * NOTE on the UI port: there is no separate Vite dev-server port in this codebase. `server.ts`
 * mounts Vite via `createViteServer({ server: { middlewareMode: true } })` and `app.use(vite.
 * middlewares)` - confirmed by direct source read, and by grep finding zero references to a
 * standalone Vite port anywhere in this repo. The UI and API share port 3000. Any report or
 * command that implies a separate UI port is incorrect for this deployment; this module and
 * argus.sh's `ui`/`open-ui` action report the single shared URL instead.
 */
type Health = 'READY' | 'STARTING' | 'DEGRADED' | 'OPTIONAL_UNAVAILABLE' | 'DISABLED' | 'STOPPED' | 'FAILED';

interface ServiceStatus {
  id: string;
  detail: string;
  health: Health;
  action: string | null;
}

/**
 * Pure classification - makes no network call itself, so it is directly unit-testable without a
 * fake server per state (argus-ecosystem-status.classify.test.ts). Callers gather portOpen/healthOk
 * from a real probe and pass them in here.
 *
 * @param optional   True for a companion (Ollama/Chronos/OpenAlice/Java Quant Core) whose absence
 *                    never makes Argus's own core API unusable - reported OPTIONAL_UNAVAILABLE,
 *                    never FAILED, once the grace period has elapsed. False for Argus's own core
 *                    API/UI, which is the one service allowed to reach real FAILED.
 * @param bootElapsedSeconds  Real elapsed seconds since the ecosystem launch was requested (from
 *                    argus.sh's own tracked launcher timestamp) - undefined/omitted means "unknown
 *                    elapsed time, assume mature" (a bare `./argus.sh status` with no active start
 *                    in flight), which preserves this function's pre-hardening behavior for that case.
 * @param graceSeconds  How long a service gets before a not-yet-healthy result stops being read as
 *                    "still starting." Defaults to ECOSYSTEM_BOOT_GRACE_SECONDS below - the real,
 *                    documented worst-case companion chain (devWithOpenAlice.ts's own up-to-180s
 *                    Chronos/OpenAlice waits, run in parallel, before server.ts is even spawned).
 */
export function classifyServiceHealth(params: {
  portOpen: boolean;
  healthOk: boolean;
  optional: boolean;
  bootElapsedSeconds?: number;
  graceSeconds?: number;
}): Health {
  const { portOpen, healthOk, optional } = params;
  if (healthOk) return 'READY';
  if (portOpen) {
    // Real refinement (2026-09-23, found live): "port open, health not answering" only means
    // "genuinely still booting" when there is actual elapsed-time evidence of a recent launch. A
    // bare status check with no active start tracked (bootElapsedSeconds undefined) has no basis
    // to assume this is a fresh boot - it is at least as likely a long-running service that is
    // currently unhealthy, which is a materially different, more actionable signal (DEGRADED) than
    // "still starting." Reproduced live: Ollama/Chronos/OpenAlice/Java Quant Core, all long-running
    // from earlier in the same session, each timed out on their health probe during a plain
    // `./argus.sh status` call with no launch in flight - STARTING would have been a real,
    // misleading label for that.
    return params.bootElapsedSeconds !== undefined ? 'STARTING' : 'DEGRADED';
  }
  const graceSeconds = params.graceSeconds ?? ECOSYSTEM_BOOT_GRACE_SECONDS;
  // bootElapsedSeconds is only ever supplied right after a start/restart action (argus.sh's own
  // tracked launcher timestamp). A bare status check with no active start in flight omits it
  // entirely - there is no legitimate "still booting" context to extend leniency for in that case,
  // so it must NOT get the benefit of the doubt (that would make a genuinely dead process report
  // STARTING forever). Leniency only applies when there is real elapsed-time evidence showing the
  // boot is still within its documented budget.
  const withinGrace = params.bootElapsedSeconds !== undefined && params.bootElapsedSeconds < graceSeconds;
  if (withinGrace) return 'STARTING'; // no positive evidence yet, but still inside the real documented boot budget
  return optional ? 'OPTIONAL_UNAVAILABLE' : 'FAILED';
}

/** devWithOpenAlice.ts's own real, documented worst case: Chronos and OpenAlice each get up to
 *  180s (run in parallel via Promise.all), and server.ts is not even spawned until both/all
 *  companion waits resolve. 90s (the previous fixed wait_for_ecosystem window) never covered this. */
export const ECOSYSTEM_BOOT_GRACE_SECONDS = 210;

const mode = process.argv.includes('--mode') && process.argv[process.argv.indexOf('--mode') + 1] === 'stopped'
  ? 'stopped'
  : 'live';
const afterStart = process.argv.includes('--after-start');
const bootElapsedArg = process.argv.find((a) => a.startsWith('--boot-elapsed-seconds='));
const bootElapsedSeconds = bootElapsedArg ? Number(bootElapsedArg.slice('--boot-elapsed-seconds='.length)) : undefined;

function preferIpv4Loopback(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/$/, '');
  }
}

function resolveChronosUrl(): string {
  const port = process.env.LOCAL_AI_SERVICE_PORT || '8008';
  const raw = process.env.LOCAL_AI_SERVICE_URL || `http://127.0.0.1:${port}`;
  return preferIpv4Loopback(raw.replace(/:8000(?=\/|$)/, ':8008'));
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

async function probe(url: string, timeoutMs = 3000): Promise<{ ok: boolean; body?: any; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: true, body };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function probeWithRetry(
  url: string,
  opts: { timeoutMs: number; attempts: number; delayMs: number },
): Promise<{ ok: boolean; body?: any; error?: string }> {
  let last: { ok: boolean; body?: any; error?: string } = { ok: false, error: 'unreachable' };
  for (let i = 0; i < opts.attempts; i++) {
    last = await probe(url, opts.timeoutMs);
    if (last.ok) return last;
    if (i + 1 < opts.attempts) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function maybeStopped(port: number, id: string, label: string): Promise<ServiceStatus | null> {
  if (mode !== 'stopped') return null;
  const open = await isPortOpen(port);
  if (!open) {
    return {
      id,
      detail: `${label} not listening (expected after stop/nuke)`,
      health: 'STOPPED',
      action: null,
    };
  }
  return null;
}

async function probeOllama(): Promise<ServiceStatus> {
  if (process.env.ARGUS_SKIP_OLLAMA === 'true') {
    return {
      id: 'ollama',
      detail: 'Skipped (ARGUS_SKIP_OLLAMA=true)',
      health: 'DISABLED',
      action: null,
    };
  }
  const host = preferIpv4Loopback(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
  let port = 11434;
  try {
    const u = new URL(host);
    if (u.port) port = Number(u.port);
  } catch { /* keep default */ }

  const stopped = await maybeStopped(port, 'ollama', 'Ollama');
  if (stopped) return stopped;

  const [p, portOpen] = await Promise.all([probe(`${host}/api/tags`), isPortOpen(port)]);
  const models = p.body?.models?.map((m: any) => m.name) || [];
  const health = classifyServiceHealth({ portOpen, healthOk: p.ok, optional: true, bootElapsedSeconds });
  return {
    id: 'ollama',
    health,
    detail: p.ok ? `tags ok (${models.length} model(s))` : (health === 'STARTING' ? `still starting (${p.error || 'not ready yet'})` : (p.error || 'unreachable')),
    action: health === 'READY' || health === 'STARTING' ? null : "Install Ollama and run 'ollama serve'. npm run dev / argus.sh start tries to start it when ollama is on PATH.",
  };
}

async function probeChronos(): Promise<ServiceStatus> {
  if (process.env.ARGUS_SKIP_CHRONOS === 'true') {
    return {
      id: 'chronos-kronos',
      detail: 'Skipped (ARGUS_SKIP_CHRONOS=true)',
      health: 'DISABLED',
      action: null,
    };
  }
  const url = resolveChronosUrl();
  let port = 8008;
  try { port = Number(new URL(url).port) || 8008; } catch { /* keep */ }

  const stopped = await maybeStopped(port, 'chronos-kronos', 'Chronos/Kronos');
  if (stopped) return stopped;

  const [p, portOpen] = await Promise.all([probe(`${url}/health`), isPortOpen(port)]);
  const health = classifyServiceHealth({ portOpen, healthOk: p.ok, optional: true, bootElapsedSeconds });
  return {
    id: 'chronos-kronos',
    health,
    detail: p.ok ? `health ok (${p.body?.model || 'chronos'})` : (health === 'STARTING' ? `still loading - first model load can take up to 3 minutes (${p.error || 'not ready yet'})` : (p.error || 'unreachable')),
    action: health === 'READY' || health === 'STARTING'
      ? null
      : 'npm run dev starts Chronos. If still unavailable after boot: Python 3.10+, npm run setup:ai, confirm local_ai_service.py is running. Skip with ARGUS_SKIP_CHRONOS=true.',
  };
}

async function probeOpenAlice(): Promise<ServiceStatus> {
  if (shouldSkipOpenAlice()) {
    return {
      id: 'openalice',
      detail: openAliceSkipReason() || 'OpenAlice Guardian disabled',
      health: 'DISABLED',
      action: null,
    };
  }
  const mcpUrl = preferIpv4Loopback(process.env.OPENALICE_MCP_URL || GUARDIAN_MCP_URL);
  let port = 47332;
  try { port = Number(new URL(mcpUrl).port) || 47332; } catch { /* keep */ }

  const stopped = await maybeStopped(port, 'openalice', 'OpenAlice Guardian MCP');
  if (stopped) return stopped;

  const [identity, portOpen] = await Promise.all([mcpEndpointIsOpenAlice(mcpUrl), isPortOpen(port)]);
  const launchError = process.env.OPENALICE_LAUNCH_ERROR?.trim();
  if (identity.ok) {
    return {
      id: 'openalice',
      health: 'READY',
      detail: identity.reason,
      action: null,
    };
  }
  const health = classifyServiceHealth({ portOpen, healthOk: false, optional: true, bootElapsedSeconds });
  const detail = launchError ? `${identity.reason} — ${launchError}` : identity.reason;
  return {
    id: 'openalice',
    health,
    detail: health === 'STARTING'
      ? `still starting (${detail})`
      : (detail.startsWith('Unreachable') || detail.startsWith('Wrong') ? detail : `Unreachable: ${detail}`),
    action: health === 'STARTING' ? null : 'Start OpenAlice Guardian (npm run dev / argus.sh start). Set OPENALICE_PATH or OPENALICE_REPO_PATH. Skip with ARGUS_SKIP_OPENALICE=true or ENABLE_OPENALICE=false.',
  };
}

async function probeJavaQuantCore(): Promise<ServiceStatus> {
  if (process.env.QUANT_JAVA_CORE_ENABLED !== 'true') {
    return {
      id: 'quant-core-java',
      detail: 'Disabled (QUANT_JAVA_CORE_ENABLED is not true - default off, opt-in shadow bridge)',
      health: 'DISABLED',
      action: null,
    };
  }
  // Fixed at 8085 - matches config/tradingSafety.json's quantJavaCoreBaseUrl, which is what
  // QuantCoreBridge.ts (the TS side actually calling this process) uses. Not independently
  // configurable via env yet - an env override here without a matching one in tradingSafety.json
  // would silently point this status probe at the wrong port.
  const port = 8085;

  const stopped = await maybeStopped(port, 'quant-core-java', 'Java Quant Core');
  if (stopped) return stopped;

  const [p, portOpen] = await Promise.all([probe(`http://127.0.0.1:${port}/health`), isPortOpen(port)]);
  // Java Quant Core is opt-in (QUANT_JAVA_CORE_ENABLED=true) but this module's own probeIbkr
  // convention treats an explicitly-enabled companion as still "optional" for ecosystem-FAILED
  // purposes - its absence never makes Argus's own core API/trading path unusable (see
  // docs/architecture/ARGUS_ARCHITECTURE.md § Java Quant Core: advisory-only, zero live authority).
  const health = classifyServiceHealth({ portOpen, healthOk: p.ok, optional: true, bootElapsedSeconds });
  return {
    id: 'quant-core-java',
    health,
    detail: p.ok ? `health ok (${p.body?.activeSymbols ?? 0} active symbol(s))` : (health === 'STARTING' ? `still starting (mvn build + boot can take a minute on first run) (${p.error || 'not ready yet'})` : (p.error || 'unreachable')),
    action: health === 'READY' || health === 'STARTING' ? null : 'npm run dev starts Java Quant Core when QUANT_JAVA_CORE_ENABLED=true. See logs/quant-core-java.log, or build manually: cd quant-core-java && mvn -B package -DskipTests',
  };
}

async function probeIbkr(): Promise<ServiceStatus> {
  const {
    probeIbkrEcosystemHealth,
    resolveActiveBrokerIdForHealth,
    resolveIbkrSessionAccountId,
  } = await import('../src/server/services/ibkrEcosystemHealth');

  const activeBrokerId = await resolveActiveBrokerIdForHealth();
  const sessionAccountId = await resolveIbkrSessionAccountId();
  const r = await probeIbkrEcosystemHealth({
    activeBrokerIdOrName: activeBrokerId,
    sessionAccountId,
    expectStopped: mode === 'stopped',
  });

  return {
    id: 'ibkr-gateway',
    health: r.health === 'DISABLED' ? 'DISABLED' : r.health,
    detail: r.detail,
    action: r.action,
  };
}

async function probeArgus(): Promise<ServiceStatus> {
  const stopped = await maybeStopped(3000, 'argus', 'Argus Node/Vite server');
  if (stopped) return stopped;

  const portOpen = await isPortOpen(3000);
  const p = await probeWithRetry('http://127.0.0.1:3000/health', {
    timeoutMs: afterStart ? 12_000 : 6_000,
    attempts: afterStart ? 5 : 2,
    delayMs: 2_000,
  });
  if (p.ok) {
    return {
      id: 'argus',
      health: 'READY',
      detail: 'GET /health ok (port 3000)',
      action: null,
    };
  }
  if (portOpen && afterStart) {
    return {
      id: 'argus',
      health: 'STARTING',
      detail: `Port 3000 listening; GET /health slow or busy (${p.error || 'timeout'}). Boot may still be finishing agents.`,
      action: 'Wait a few seconds and run ./argus.sh status again, or run ./argus.sh wait-ready.',
    };
  }
  if (portOpen) {
    return {
      id: 'argus',
      health: 'STARTING',
      detail: `Port 3000 listening; GET /health not ready (${p.error || 'timeout'})`,
      action: 'Check logs/argus-dev.log — server may still be booting.',
    };
  }
  // Real fix (2026-09-23): port 3000 is not even open until AFTER every companion wait in
  // devWithOpenAlice.ts's main() resolves (Chronos/OpenAlice up to 180s each, run in parallel) -
  // server.ts is not spawned before that. Reporting FAILED here purely because port 3000 hasn't
  // opened yet, with no regard for how long the ecosystem has actually been booting, was the exact
  // false-negative this hardening pass exists to fix. classifyServiceHealth() only returns FAILED
  // once bootElapsedSeconds (argus.sh's own tracked launcher timestamp, passed via
  // --boot-elapsed-seconds) has genuinely exceeded ECOSYSTEM_BOOT_GRACE_SECONDS - a real, documented
  // budget, not a bigger version of the same guess.
  const health = classifyServiceHealth({ portOpen, healthOk: false, optional: false, bootElapsedSeconds });
  return {
    id: 'argus',
    health,
    detail: health === 'STARTING'
      ? `Port 3000 not open yet (${bootElapsedSeconds ?? 0}s since launch; companions can legitimately take up to ${ECOSYSTEM_BOOT_GRACE_SECONDS}s before server.ts even starts) - ${p.error || 'not reachable yet'}`
      : (p.error || 'unreachable'),
    action: health === 'STARTING'
      ? 'Still booting - run ./argus.sh wait-ready, or ./argus.sh status again shortly.'
      : 'Check logs/argus-dev.log. Port 3000 has not opened within the real documented boot budget - this may be a genuine failure.',
  };
}

function printService(s: ServiceStatus): void {
  console.log(s.id);
  console.log(s.detail);
  if (s.action) console.log(`Action: ${s.action}`);
  console.log(s.health);
  console.log('');
}

async function main(): Promise<void> {
  // Probe companions first; Argus last so a busy boot event loop does not starve /health.
  const companions = await Promise.all([
    probeOllama(),
    probeChronos(),
    probeOpenAlice(),
    probeIbkr(),
    probeJavaQuantCore(),
  ]);
  if (afterStart) await sleep(1_000);
  const argus = await probeArgus();
  for (const s of [...companions, argus]) printService(s);

  // Ecosystem-level summary (2026-09-23 hardening): the single headline a caller actually needs -
  // "is Argus itself usable" - kept structurally separate from companion health, so an optional
  // companion never makes this read wrong. Only Argus's own health decides READY/STARTING/FAILED here.
  if (mode === 'stopped') {
    console.log('ARGUS ECOSYSTEM STOPPED');
  } else if (argus.health === 'READY') {
    console.log('ARGUS READY');
    console.log('');
    // No separate Vite port in this codebase - server.ts mounts Vite as Express middleware on the
    // SAME port (middlewareMode: true). UI and API share one URL; printing two different ones
    // would be reporting a port that never binds.
    console.log('API: http://127.0.0.1:3000');
    console.log('UI:  http://127.0.0.1:3000  (Vite is mounted as Express middleware on the same port - no separate UI port exists in this deployment)');
  } else if (argus.health === 'STARTING') {
    console.log('ARGUS ECOSYSTEM STARTING');
    console.log('');
    console.log('Argus is still booting.');
    console.log('Run:');
    console.log('  ./argus.sh wait-ready');
    console.log('  ./argus.sh status');
  } else {
    console.log('ARGUS ECOSYSTEM FAILED');
    console.log('');
    console.log(`Argus core: ${argus.detail}`);
    console.log('Check logs/argus-dev.log for the real cause before assuming a transient boot delay.');
  }
}

// Guarded (2026-09-23, same pattern as ecosystem-dev.ts's isDirectRun check) so
// argus-ecosystem-status.classify.test.ts can import classifyServiceHealth/ECOSYSTEM_BOOT_GRACE_SECONDS
// without triggering a real main() run (live network probes + process.exit()) as an import side effect.
const isDirectRun =
  process.argv[1] != null &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((e) => {
    console.error(`argus-ecosystem-status: ${e?.message || e}`);
    process.exit(1);
  });
}
