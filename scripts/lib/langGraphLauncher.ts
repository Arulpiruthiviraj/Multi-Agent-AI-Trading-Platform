/**
 * Shared LangGraph research-service companion launcher (docs/architecture/ARGUS_ARCHITECTURE.md (LangGraph Research Service section)).
 * Mirrors chronosLauncher.ts's structure exactly - self-contained isPortOpen/waitForHttpOk/
 * findPython rather than importing devWithOpenAlice.ts (not designed as a library), same reasoning
 * as that file's own header.
 *
 * OFF BY DEFAULT (opposite polarity from Chronos, same polarity as Java Quant Core): this is a new,
 * unvalidated, shadow-only advisory capability, not yet a normal expected companion - callers should
 * gate this on `LANGGRAPH_RESEARCH_ENABLED === 'true'` (config/langGraphResearch.json's master flag),
 * not start it unconditionally.
 *
 * Never throws to the caller - a failure here must never take down the real engine daemon, only
 * leave the LangGraph research service unavailable (LangGraphResearchService.ts already fails
 * closed to a typed { ok: false } result on exactly that case).
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { acquireCompanionLaunchLock, releaseCompanionLaunchLock } from './companionLaunchLock';

const LOCK_NAME = 'langgraph_research';

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
  console.warn(`[engine] Timed out waiting for ${label} at ${url} (${timeoutMs}ms). The engine still starts; the LangGraph research service stays unavailable until it is reachable.`);
  return false;
}

/** Never throws - any failure just leaves this optional companion unavailable. */
export async function ensureLangGraphResearchRunning(repoRoot: string, port: number): Promise<void> {
  try {
    await ensureLangGraphResearchRunningUnsafe(repoRoot, port);
  } catch (e: any) {
    console.warn(`[engine] LangGraph research service startup failed unexpectedly (${e?.message || e}). The engine itself is unaffected - continuing without it.`);
  }
}

async function ensureLangGraphResearchRunningUnsafe(repoRoot: string, port: number): Promise<void> {
  const healthUrl = `http://127.0.0.1:${port}/health`;

  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      console.log(`[engine] LangGraph research service already healthy at ${healthUrl} - not starting a second copy.`);
      return;
    }
  } catch {
    // need start or wait
  }

  if (await isPortOpen(port)) {
    console.log(`[engine] Port ${port} is open but ${healthUrl} is not healthy yet - waiting (up to 60s)...`);
    await waitForHttpOk(healthUrl, 60_000, 'LangGraph research service GET /health');
    return;
  }

  const lock = acquireCompanionLaunchLock(repoRoot, LOCK_NAME, port);
  if (lock.acquired === false) {
    console.log(`[engine] Another process (pid ${lock.holderPid}) is already launching the LangGraph research service - waiting for it to become healthy instead of starting a second copy.`);
    await waitForHttpOk(healthUrl, 60_000, 'LangGraph research service GET /health');
    return;
  }

  try {
    await spawnLangGraphResearch(repoRoot, port, healthUrl);
  } finally {
    releaseCompanionLaunchLock(repoRoot, LOCK_NAME);
  }
}

async function spawnLangGraphResearch(repoRoot: string, port: number, healthUrl: string): Promise<void> {
  const python = findPython();
  if (!python) {
    console.warn('[engine] No python/python3/py on PATH. LangGraph research service stays unavailable. Install Python 3.11+ and the packages in langgraph-research/requirements.txt.');
    return;
  }

  const serviceDir = path.join(repoRoot, 'langgraph-research');
  const script = path.join(serviceDir, 'app', 'server.py');
  if (!fs.existsSync(script)) {
    console.warn(`[engine] Missing ${script} - cannot start the LangGraph research service.`);
    return;
  }

  fs.mkdirSync(path.join(repoRoot, 'logs'), { recursive: true });
  const logFd = fs.openSync(path.join(repoRoot, 'logs', 'langgraph-research.log'), 'a');
  // Real bug found live (2026-09-03): app/server.py uses relative imports ("from . import
  // config"), which only work when Python is invoked as a package module (-m app.server) from
  // this cwd - invoking it as a bare script path ("python .../app/server.py") makes Python treat
  // it as a parented-less __main__ module and every relative import throws ImportError
  // immediately. `python -m app.server` is the correct invocation, same as running it manually.
  console.log(`[engine] Starting LangGraph research service via ${python.cmd} ${[...python.prefix, '-m', 'app.server'].join(' ')} (cwd ${serviceDir}, port ${port}, logging to logs/langgraph-research.log).`);
  const child = spawn(python.cmd, [...python.prefix, '-m', 'app.server'], {
    cwd: serviceDir,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    detached: true,
    // PYTHONUNBUFFERED=1: without it, stdout is block-buffered once redirected to a file (not a
    // terminal), so log_event()/print() lines sit invisible in the OS buffer for a long time -
    // observed live: the process was demonstrably healthy (curl /health succeeded) well before
    // its own startup line appeared in logs/langgraph-research.log.
    env: { ...process.env, LANGGRAPH_RESEARCH_PORT: String(port), PYTHONUNBUFFERED: '1' },
  });
  fs.closeSync(logFd);
  child.unref();
  child.on('exit', (code, signal) => {
    console.warn(`[engine] LangGraph research service exited (code=${code}, signal=${signal}). See logs/langgraph-research.log.`);
  });

  const ok = await waitForHttpOk(healthUrl, 60_000, 'LangGraph research service GET /health');
  if (ok) {
    console.log(`[engine] LangGraph research service is healthy at ${healthUrl}`);
  } else {
    console.warn('[engine] LangGraph research service did not become healthy within 60s. See logs/langgraph-research.log.');
  }
}
