/**
 * Shared Chronos/Kronos companion launcher - lets the headless engine daemon
 * (scripts/argus-engine.ts, what `./argus start` / `argus-cli start` actually runs) bring Chronos
 * up too, not only the full ecosystem launcher (scripts/devWithOpenAlice.ts, what `npm run dev`
 * runs, which already has its own startChronosAndWait()).
 *
 * Deliberately self-contained (own isPortOpen/waitForHttpOk/findPython) rather than importing from
 * devWithOpenAlice.ts, which is not designed as a library and stays untouched here to avoid
 * destabilizing its own already-working ecosystem-launch behavior - same reasoning as
 * javaQuantCoreLauncher.ts's header, whose structure this mirrors.
 *
 * On by default (opposite polarity from Java Quant Core's opt-in QUANT_JAVA_CORE_ENABLED): Chronos
 * is a normal, expected companion (same ARGUS_SKIP_CHRONOS convention devWithOpenAlice.ts already
 * uses), not an experimental one. Callers should gate this on `ARGUS_SKIP_CHRONOS !== 'true'`.
 *
 * Never throws to the caller - a failure here must never take down the real engine daemon, only
 * leave Kronos honestly KRONOS_UNAVAILABLE (KronosForecastAgent/KronosEngine already fail closed on
 * that per CLAUDE.md - never fabricate a forecast).
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { acquireCompanionLaunchLock, releaseCompanionLaunchLock } from './companionLaunchLock';

const LOCK_NAME = 'chronos';

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

function commandWorks(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  return r.status === 0;
}

function findPython(): { cmd: string; prefix: string[] } | null {
  if (commandWorks('python', ['--version'])) return { cmd: 'python', prefix: [] };
  if (commandWorks('python3', ['--version'])) return { cmd: 'python3', prefix: [] };
  if (commandWorks('py', ['-3', '--version'])) return { cmd: 'py', prefix: ['-3'] };
  return null;
}

async function waitForHttpOk(url: string, timeoutMs: number, label: string): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return true;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.warn(`[engine] Timed out waiting for ${label} at ${url} (${timeoutMs}ms). The engine still starts; Kronos stays honestly unavailable until it is reachable.`);
  return false;
}

/** Never throws - any failure just leaves this optional companion unavailable. */
export async function ensureChronosRunning(repoRoot: string): Promise<void> {
  try {
    await ensureChronosRunningUnsafe(repoRoot);
  } catch (e: any) {
    console.warn(`[engine] Chronos/Kronos startup failed unexpectedly (${e?.message || e}). The engine itself is unaffected - continuing without it.`);
  }
}

async function ensureChronosRunningUnsafe(repoRoot: string): Promise<void> {
  // Matches CLAUDE.md / devWithOpenAlice.ts's own default - always pin to 8008 unless explicitly overridden.
  const port = Number(process.env.LOCAL_AI_SERVICE_PORT || '8008');
  const healthUrl = `http://127.0.0.1:${port}/health`;

  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      console.log(`[engine] Chronos/Kronos already healthy at ${healthUrl} - not starting a second copy.`);
      return;
    }
  } catch {
    // need start or wait
  }

  if (await isPortOpen(port)) {
    console.log(`[engine] Port ${port} is open but ${healthUrl} is not healthy yet - waiting for model load (up to 3 min)...`);
    await waitForHttpOk(healthUrl, 180_000, 'Chronos/Kronos GET /health');
    return;
  }

  // Same TOCTOU race javaQuantCoreLock.ts was built for: `npm run dev` (devWithOpenAlice.ts's own
  // startChronosAndWait()) and `./argus start`/`argus-cli start` (this launcher) can both decide to
  // spawn local_ai_service.py within the same few seconds if run close together.
  const lock = acquireCompanionLaunchLock(repoRoot, LOCK_NAME, port);
  if (lock.acquired === false) {
    console.log(`[engine] Another process (pid ${lock.holderPid}) is already launching Chronos - waiting for it to become healthy instead of starting a second copy.`);
    await waitForHttpOk(healthUrl, 180_000, 'Chronos/Kronos GET /health');
    return;
  }

  try {
    await spawnChronos(repoRoot, port, healthUrl);
  } finally {
    releaseCompanionLaunchLock(repoRoot, LOCK_NAME);
  }
}

async function spawnChronos(repoRoot: string, port: number, healthUrl: string): Promise<void> {
  const python = findPython();
  if (!python) {
    console.warn(
      '[engine] No python/python3/py on PATH. Kronos stays KRONOS_UNAVAILABLE. Install Python ' +
      '3.10+, run `npm run setup:ai`, then restart (or `npm run ai:serve` in another terminal).',
    );
    return;
  }

  const script = path.join(repoRoot, 'scripts', 'local_ai_service.py');
  if (!fs.existsSync(script)) {
    console.warn(`[engine] Missing ${script} - cannot start Chronos/Kronos.`);
    return;
  }

  fs.mkdirSync(path.join(repoRoot, 'logs'), { recursive: true });
  // fs.openSync returns an already-open, synchronously-valid fd - required by spawn()'s stdio array
  // (a not-yet-open fs.createWriteStream can race ahead of open() - see
  // javaQuantCoreLauncher.ts's own fixed-bug comment for the same issue).
  const logFd = fs.openSync(path.join(repoRoot, 'logs', 'chronos.log'), 'a');
  console.log(`[engine] Starting Chronos/Kronos + FinBERT via ${python.cmd} ${[...python.prefix, script].join(' ')} (port ${port}, logging to logs/chronos.log). First load can take a minute.`);
  const child = spawn(python.cmd, [...python.prefix, script], {
    cwd: repoRoot,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    detached: true,
    env: { ...process.env, LOCAL_AI_SERVICE_PORT: String(port) },
  });
  fs.closeSync(logFd);
  // Detached + unref: a loosely-coupled companion, not a supervised child of the engine daemon -
  // keeps running independently and does not keep the engine process's event loop alive on its account.
  child.unref();
  child.on('exit', (code, signal) => {
    console.warn(`[engine] Chronos/Kronos exited (code=${code}, signal=${signal}). See logs/chronos.log. Typical causes: missing torch/chronos (npm run setup:ai / requirements-ai.txt) or the Hugging Face model download failing.`);
  });

  const ok = await waitForHttpOk(healthUrl, 180_000, 'Chronos/Kronos GET /health');
  if (ok) {
    console.log(`[engine] Chronos/Kronos is healthy at ${healthUrl}`);
  } else {
    console.warn('[engine] Chronos did not become healthy within 3 minutes. See logs/chronos.log.');
  }
}
