/**
 * Shared Java Quant Core companion launcher - extracted so the lean headless engine daemon
 * (scripts/argus-engine.ts, what `./argus start` actually runs) can also bring the companion up,
 * not only the full ecosystem launcher (scripts/devWithOpenAlice.ts, what `npm run dev` runs).
 *
 * Deliberately self-contained (own isPortOpen/waitForHttpOk/commandWorks) rather than importing
 * from devWithOpenAlice.ts, which is not designed as a library and stays untouched here to avoid
 * destabilizing its own already-working ecosystem-launch behavior.
 *
 * Advisory-only, loopback-only, no broker access (docs/architecture/ARGUS_ARCHITECTURE.md (Java Quant Core section)).
 * Off by default: only starts when QUANT_JAVA_CORE_ENABLED=true. Never throws to the caller - a
 * failure here must never take down the real engine daemon, only leave this companion unavailable.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { acquireJavaQuantCoreLaunchLock, releaseJavaQuantCoreLaunchLock } from './javaQuantCoreLock';

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
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.warn(`[engine] Timed out waiting for ${label} at ${url} (${timeoutMs}ms). The engine still starts; Java Quant Core stays honestly unavailable until it is reachable.`);
  return false;
}

/** Never throws - any failure just leaves this optional companion unavailable. */
export async function startJavaQuantCoreAndWait(repoRoot: string): Promise<void> {
  try {
    await startJavaQuantCoreAndWaitUnsafe(repoRoot);
  } catch (e: any) {
    console.warn(`[engine] Java Quant Core startup failed unexpectedly (${e?.message || e}). The engine itself is unaffected - continuing without it.`);
  }
}

async function startJavaQuantCoreAndWaitUnsafe(repoRoot: string): Promise<void> {
  // Fixed at 8085 - matches config/tradingSafety.json's quantJavaCoreBaseUrl (what
  // QuantCoreBridge.ts actually connects to). Same constraint devWithOpenAlice.ts's own
  // startJavaQuantCoreAndWaitUnsafe() documents.
  const port = 8085;
  const healthUrl = `http://127.0.0.1:${port}/health`;

  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      console.log(`[engine] Java Quant Core already healthy at ${healthUrl} - not starting a second copy.`);
      return;
    }
  } catch {
    // need start or wait
  }

  if (await isPortOpen(port)) {
    console.log(`[engine] Port ${port} is open but ${healthUrl} is not healthy yet - waiting (up to 60s)...`);
    await waitForHttpOk(healthUrl, 60_000, 'Java Quant Core GET /health');
    return;
  }

  // Real fix (2026-08-24 readiness audit, Part 6): the checks above (health probe, port probe) are
  // the cheap first line of defense, but there is a real TOCTOU race between "checked, saw nothing
  // running" and the actual spawn below - this session found exactly that: two java.exe processes
  // bound to the same port, from this launcher and devWithOpenAlice.ts's independent copy racing
  // each other. The lock closes that specific window; it never replaces the health check above as
  // the source of truth for "is Java Quant Core actually up."
  const lock = acquireJavaQuantCoreLaunchLock(repoRoot, port);
  if (lock.acquired === false) {
    console.log(`[engine] Another process (pid ${lock.holderPid}) is already launching Java Quant Core - waiting for it to become healthy instead of starting a second copy.`);
    await waitForHttpOk(healthUrl, 60_000, 'Java Quant Core GET /health');
    return;
  }

  try {
    await spawnJavaQuantCore(repoRoot, port, healthUrl);
  } finally {
    releaseJavaQuantCoreLaunchLock(repoRoot);
  }
}

async function spawnJavaQuantCore(repoRoot: string, port: number, healthUrl: string): Promise<void> {
  const moduleDir = path.join(repoRoot, 'quant-core-java');
  const jarPath = path.join(moduleDir, 'target', 'quant-core-java-0.0.1-SNAPSHOT.jar');
  if (!fs.existsSync(moduleDir)) {
    console.warn(`[engine] QUANT_JAVA_CORE_ENABLED=true but ${moduleDir} does not exist - skipping.`);
    return;
  }

  if (!fs.existsSync(jarPath)) {
    if (!commandWorks('mvn', ['-v'])) {
      console.warn('[engine] QUANT_JAVA_CORE_ENABLED=true but the jar is missing and Maven is not on PATH. Build manually: cd quant-core-java && mvn -B package -DskipTests');
      return;
    }
    console.log('[engine] quant-core-java jar not found - building (mvn -B package -DskipTests, first run only)...');
    const build = spawnSync('mvn', ['-B', 'package', '-DskipTests'], {
      cwd: moduleDir,
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    if (build.status !== 0 || !fs.existsSync(jarPath)) {
      console.warn(`[engine] quant-core-java build failed (code=${build.status}) - Java Quant Core will stay unavailable this session.`);
      return;
    }
  }

  fs.mkdirSync(path.join(repoRoot, 'logs'), { recursive: true });
  // fs.openSync returns an already-open, synchronously-valid fd - required by spawn()'s stdio
  // array (a not-yet-open fs.createWriteStream raced ahead of open() and threw here previously,
  // see devWithOpenAlice.ts's own fixed-bug comment for the same issue).
  const logFd = fs.openSync(path.join(repoRoot, 'logs', 'quant-core-java.log'), 'a');
  console.log(`[engine] Starting Java Quant Core on :${port} (logging to logs/quant-core-java.log)`);
  const child = spawn('java', ['-jar', jarPath, String(port)], {
    cwd: moduleDir,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    detached: true,
  });
  fs.closeSync(logFd);
  // Detached + unref: this is a loosely-coupled companion, not a supervised child of the engine
  // daemon (which itself typically runs detached/backgrounded via ./argus start) - it keeps
  // running independently and does not keep the engine process's event loop alive on its account.
  child.unref();
  child.on('exit', (code, signal) => {
    console.warn(`[engine] Java Quant Core exited (code=${code}, signal=${signal}). See logs/quant-core-java.log.`);
  });

  const ok = await waitForHttpOk(healthUrl, 60_000, 'Java Quant Core GET /health');
  if (ok) {
    console.log(`[engine] Java Quant Core is healthy at ${healthUrl}`);
  } else {
    console.warn('[engine] Java Quant Core did not become healthy within 60s. See logs/quant-core-java.log.');
  }
}
