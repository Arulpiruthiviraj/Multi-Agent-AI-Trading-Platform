/**
 * Shared Ollama companion launcher - lets the headless engine daemon (scripts/argus-engine.ts,
 * what `./argus start` / `argus-cli start` actually runs) bring Ollama up too, not only report it
 * as FAILED/DISABLED.
 *
 * Real gap this closes (2026-09-07): `ModelRuntimeManager.startAndProbe()` only spawns Ollama when
 * `ARGUS_START_LOCAL_MODELS=true` (set by `npm run dev`'s ecosystem launcher, scripts/
 * devWithOpenAlice.ts) - the headless engine daemon never sets that flag, so `./argus start` only
 * ever probed Ollama and reported failure, unlike Chronos/Kronos which already has its own
 * always-on ensureChronosRunning() (chronosLauncher.ts) for exactly this path. This mirrors that
 * file's structure deliberately (same isPortOpen/waitForHttpOk shape, same companion-launch-lock
 * use) rather than reimplementing the pattern differently.
 *
 * On by default (ARGUS_SKIP_OLLAMA convention, matching Chronos's own ARGUS_SKIP_CHRONOS):
 * Ollama is a normal, expected companion for AIRouter's local-model routes (NewsAgent/
 * FundamentalAgent/MacroAgent fallback, ReflectionEngine, ExplainabilityAgent - see CLAUDE.md §3).
 *
 * Never throws to the caller - a failure here must never take down the real engine daemon; AIRouter
 * already fails over to remote providers (or a fail-closed HOLD) when Ollama stays unreachable.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { acquireCompanionLaunchLock, releaseCompanionLaunchLock } from './companionLaunchLock';

const LOCK_NAME = 'ollama';

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

async function waitForHttpOk(url: string, timeoutMs: number, label: string): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) return true;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn(`[engine] Timed out waiting for ${label} at ${url} (${timeoutMs}ms). The engine still starts; AI-routed agents fail over to remote providers (or fail closed) until Ollama is reachable.`);
  return false;
}

/** Never throws - any failure just leaves this optional companion unavailable. */
export async function ensureOllamaRunning(repoRoot: string): Promise<void> {
  try {
    await ensureOllamaRunningUnsafe(repoRoot);
  } catch (e: any) {
    console.warn(`[engine] Ollama startup failed unexpectedly (${e?.message || e}). The engine itself is unaffected - continuing without it.`);
  }
}

async function ensureOllamaRunningUnsafe(repoRoot: string): Promise<void> {
  const port = Number(process.env.OLLAMA_PORT || '11434');
  const host = process.env.OLLAMA_HOST?.trim() || `http://127.0.0.1:${port}`;
  const tagsUrl = `${host.replace(/\/$/, '')}/api/tags`;

  try {
    const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      console.log(`[engine] Ollama already healthy at ${tagsUrl} - not starting a second copy.`);
      return;
    }
  } catch {
    // need start or wait
  }

  if (await isPortOpen(port)) {
    console.log(`[engine] Port ${port} is open but ${tagsUrl} is not healthy yet - waiting (up to 30s)...`);
    await waitForHttpOk(tagsUrl, 30_000, 'Ollama GET /api/tags');
    return;
  }

  const lock = acquireCompanionLaunchLock(repoRoot, LOCK_NAME, port);
  if (lock.acquired === false) {
    console.log(`[engine] Another process (pid ${lock.holderPid}) is already launching Ollama - waiting for it to become healthy instead of starting a second copy.`);
    await waitForHttpOk(tagsUrl, 60_000, 'Ollama GET /api/tags');
    return;
  }

  try {
    await spawnOllama(port, tagsUrl);
  } finally {
    releaseCompanionLaunchLock(repoRoot, LOCK_NAME);
  }
}

async function spawnOllama(port: number, tagsUrl: string): Promise<void> {
  if (!commandWorks('ollama', ['--version'])) {
    console.warn(
      '[engine] Ollama is not running and the `ollama` CLI is not on PATH - cannot start it. ' +
      'AI-routed agents (NewsAgent/FundamentalAgent/MacroAgent/ReflectionEngine) fail over to ' +
      'remote providers, or fail closed to HOLD if none are healthy either. Install Ollama ' +
      '(https://ollama.com/download) or start it manually, then restart Argus.',
    );
    return;
  }

  console.log(`[engine] Starting Ollama via \`ollama serve\` (port ${port}). First load can take a few seconds.`);
  try {
    const child = spawn('ollama', ['serve'], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
      shell: process.platform === 'win32',
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` },
    });
    child.unref();
    child.on('exit', (code, signal) => {
      console.warn(`[engine] Ollama process exited (code=${code}, signal=${signal}). It may already be running as a separate service/tray app - this is not necessarily a failure.`);
    });
  } catch (e: any) {
    console.warn(`[engine] Failed to spawn \`ollama serve\`: ${e.message}. Start Ollama manually, then restart Argus.`);
    return;
  }

  const ok = await waitForHttpOk(tagsUrl, 30_000, 'Ollama GET /api/tags');
  if (ok) {
    console.log(`[engine] Ollama is healthy at ${tagsUrl}`);
  } else {
    console.warn('[engine] Ollama did not become healthy within 30s after starting. Check whether another Ollama instance (tray app) is already bound to this port, or start it manually.');
  }
}
