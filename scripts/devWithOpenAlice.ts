/**
 * ==========================================================
 * Script: devWithOpenAlice.ts
 *
 * Purpose:
 * `npm run dev:core` entry point (also invoked by `npm run dev` → ecosystem-dev.ts).
 * Starts `tsx server.ts` plus local companions so Kronos is not left
 * KRONOS_UNAVAILABLE just because nobody ran `npm run ai:serve` in another terminal.
 *
 *   1. Chronos/Kronos + FinBERT (`scripts/local_ai_service.py` on LOCAL_AI_SERVICE_PORT, default
 *      8008) unless ARGUS_SKIP_CHRONOS=true. This is what KronosEngine / KronosForecastAgent call.
 *   2. Ollama (`ollama serve` on 11434) unless ARGUS_SKIP_OLLAMA=true or something already listens.
 *   3. OpenAlice Guardian (sibling checkout, OPENALICE_PATH / OPENALICE_REPO_PATH, or git clone)
 *      unless ARGUS_SKIP_OPENALICE=true or ENABLE_OPENALICE=false. Waits for MCP readiness at
 *      http://127.0.0.1:47332/mcp (OPENALICE_MCP_ENABLED=1) before starting Node. Never the UTA
 *      trading MCP.
 *   4. IBKR Client Portal Gateway when IBKR_GATEWAY_PATH is set or a common install path is found.
 *      Opens https://localhost:<port> for login. Does NOT complete 2FA (not possible).
 *
 * `npm run dev:server-only` / Playwright (`npx tsx server.ts`) do not start these.
 * Ctrl+C kills only processes this script spawned.
 * ==========================================================
 */
import 'dotenv/config';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import {
  GUARDIAN_MCP_PORT,
  GUARDIAN_MCP_URL,
  GUARDIAN_WEB_PORT,
  mcpEndpointAccepting,
  mcpEndpointIsOpenAlice,
  openAliceHowToEnable,
  openAliceSkipReason,
  shouldSkipOpenAlice,
  waitForOpenAliceMcp,
} from './openAliceDevSupport';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const children: ChildProcess[] = [];
let shuttingDown = false;
let openAliceLaunchError: string | null = null;

function preferIpv4Loopback(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/$/, '');
  }
}

function openUrlInBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    console.log(`[dev] Opened ${url} in the default browser.`);
  } catch (e: any) {
    console.warn(`[dev] Could not open a browser for ${url}: ${e.message}`);
  }
}

function killAll(signal: NodeJS.Signals = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.on('SIGINT', () => { killAll('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { killAll('SIGTERM'); process.exit(0); });

/** Real TCP probe, not a guess - resolves true only if something actually accepts a connection. */
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
    // Windows shims are *.cmd; spawnSync without a shell reports "not found" even when PATH is fine.
    shell: process.platform === 'win32',
  });
  return r.status === 0;
}

/** OpenAlice's packageManager is pnpm. On Windows the shim is pnpm.cmd. */
function resolvePnpmCommand(): string | null {
  if (commandWorks('pnpm', ['--version'])) return 'pnpm';
  if (process.platform === 'win32' && commandWorks('pnpm.cmd', ['--version'])) return 'pnpm.cmd';
  if (commandWorks('corepack', ['--version'])) return 'corepack';
  return null;
}

function pnpmBin(): string | null {
  return resolvePnpmCommand();
}

function findPython(): { cmd: string; prefix: string[] } | null {
  if (commandWorks('python', ['--version'])) return { cmd: 'python', prefix: [] };
  if (commandWorks('python3', ['--version'])) return { cmd: 'python3', prefix: [] };
  if (commandWorks('py', ['-3', '--version'])) return { cmd: 'py', prefix: ['-3'] };
  return null;
}

function openAliceCheckoutPath(): string {
  return process.env.OPENALICE_REPO_PATH || path.resolve(repoRoot, '..', 'OpenAlice');
}

function openAliceCheckoutExists(): boolean {
  const openAlicePath = openAliceCheckoutPath();
  return fs.existsSync(openAlicePath) && fs.existsSync(path.join(openAlicePath, 'package.json'));
}

function ensureOpenAliceCheckout(): string | null {
  const openAlicePath = openAliceCheckoutPath();
  if (openAliceCheckoutExists()) return openAlicePath;

  if (!commandWorks('git', ['--version'])) {
    openAliceLaunchError = `No OpenAlice checkout at ${openAlicePath} and git is not on PATH. ${openAliceHowToEnable(openAlicePath)}`;
    console.warn(`[dev] ${openAliceLaunchError}`);
    return null;
  }

  console.log(`[dev] Cloning OpenAlice into ${openAlicePath} (https://github.com/TraderAlice/OpenAlice.git)`);
  const clone = spawnSync(
    'git',
    ['clone', '--depth', '1', 'https://github.com/TraderAlice/OpenAlice.git', openAlicePath],
    { encoding: 'utf8', timeout: 180_000, windowsHide: true, shell: process.platform === 'win32', stdio: 'inherit' },
  );
  if (clone.status !== 0 || !openAliceCheckoutExists()) {
    openAliceLaunchError = `git clone of OpenAlice into ${openAlicePath} failed (code=${clone.status}). ${openAliceHowToEnable(openAlicePath)}`;
    console.warn(`[dev] ${openAliceLaunchError}`);
    return null;
  }
  return openAlicePath;
}

function ensureOpenAliceDeps(openAlicePath: string, pnpmCmd: string): boolean {
  if (fs.existsSync(path.join(openAlicePath, 'node_modules'))) return true;
  console.log(`[dev] OpenAlice node_modules missing - running ${pnpmCmd} install (first boot).`);
  const args = pnpmCmd === 'corepack' ? ['pnpm', 'install'] : ['install'];
  const install = spawnSync(pnpmCmd, args, {
    cwd: openAlicePath,
    encoding: 'utf8',
    timeout: 600_000,
    windowsHide: true,
    shell: true,
    stdio: 'inherit',
  });
  if (install.status !== 0) {
    openAliceLaunchError = `OpenAlice ${pnpmCmd} install failed (code=${install.status}) in ${openAlicePath}. ${openAliceHowToEnable(openAlicePath)}`;
    console.warn(`[dev] ${openAliceLaunchError}`);
    return false;
  }
  return true;
}

async function waitForPort(port: number, timeoutMs: number, label: string): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(`[dev] Timed out waiting for ${label} on port ${port} (${timeoutMs}ms).`);
  return false;
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
  console.warn(`[dev] Timed out waiting for ${label} at ${url} (${timeoutMs}ms). The platform still starts; that companion stays honestly unavailable until it is reachable.`);
  return false;
}

async function startOllama(): Promise<void> {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
  let port = 11434;
  try {
    const u = new URL(ollamaHost);
    if (u.port) port = Number(u.port);
  } catch {
    // keep default
  }
  if (await isPortOpen(port)) {
    console.log(`[dev] Ollama already reachable on port ${port} - not starting a second ollama serve.`);
    return;
  }
  if (!commandWorks('ollama', ['--version'])) {
    console.warn('[dev] ollama is not on PATH. Local chat models will stay unreachable until you install Ollama (https://ollama.com/download) and re-run npm run dev. Kronos uses the Python Chronos service, not Ollama.');
    return;
  }
  console.log(`[dev] Starting ollama serve (local LLMs at ${ollamaHost})`);
  const child = spawn('ollama', ['serve'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.warn(`[dev] ollama serve exited (code=${code}, signal=${signal}).`);
    }
  });
}

async function startChronosAndWait(): Promise<void> {
  const port = Number(process.env.LOCAL_AI_SERVICE_PORT || '8008');
  // Always pin to 8008 unless explicitly overridden — never silently use :8000 (old docs).
  const rawUrl = process.env.LOCAL_AI_SERVICE_URL || `http://127.0.0.1:${port}`;
  const healthUrl = `${preferIpv4Loopback(rawUrl.replace(/:8000(?=\/|$)/, ':8008'))}/health`;

  // Port open is not enough — a stale listener can accept TCP while /health fails.
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      console.log(`[dev] Chronos/Kronos already healthy at ${healthUrl} - not starting a second copy.`);
      return;
    }
  } catch {
    // need start or wait
  }

  if (await isPortOpen(port)) {
    console.log(`[dev] Port ${port} is open but ${healthUrl} is not healthy yet — waiting for model load (up to 3 min)...`);
    const ok = await waitForHttpOk(healthUrl, 180_000, 'Chronos/Kronos GET /health');
    if (ok) {
      console.log(`[dev] Chronos/Kronos is healthy at ${healthUrl}`);
      return;
    }
    console.warn(`[dev] Port ${port} stayed unhealthy. Will still start Node; Kronos tab will keep probing.`);
    return;
  }

  const python = findPython();
  if (!python) {
    console.warn(
      '[dev] No python/python3/py on PATH. Kronos stays KRONOS_UNAVAILABLE. Install Python 3.10+, run `npm run setup:ai`, then restart `npm run dev` (or `npm run ai:serve` in another terminal).'
    );
    return;
  }

  const script = path.join(repoRoot, 'scripts', 'local_ai_service.py');
  if (!fs.existsSync(script)) {
    console.warn(`[dev] Missing ${script} - cannot start Chronos/Kronos.`);
    return;
  }

  console.log(`[dev] Starting Chronos/Kronos + FinBERT via ${python.cmd} ${[...python.prefix, script].join(' ')} (port ${port}). First load can take a minute.`);
  const child = spawn(python.cmd, [...python.prefix, script], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, LOCAL_AI_SERVICE_PORT: String(port) },
  });
  children.push(child);

  let exitedEarly = false;
  child.on('exit', (code, signal) => {
    exitedEarly = true;
    if (!shuttingDown) {
      console.warn(
        `[dev] local_ai_service.py exited (code=${code}, signal=${signal}). Kronos stays KRONOS_UNAVAILABLE. Typical causes: missing torch/chronos (` +
        '`npm run setup:ai` / requirements-ai.txt) or the Hugging Face model download failing.'
      );
    }
  });

  const healthPromise = waitForHttpOk(healthUrl, 180_000, 'Chronos/Kronos GET /health');
  const exitPromise = new Promise<boolean>((resolve) => {
    child.once('exit', () => resolve(false));
  });
  const ok = await Promise.race([healthPromise, exitPromise]);
  if (ok) {
    console.log(`[dev] Chronos/Kronos is healthy at ${healthUrl}`);
  } else if (!exitedEarly) {
    console.warn('[dev] Chronos is still loading or stuck. Watch the Python log above. The Node app will keep probing every 30s.');
  }
}

/**
 * Argus verification talks to OpenAlice's MCP server on :47332. This launcher's only job is
 * confirming that's genuinely OpenAlice (serverInfo.name === 'open-alice'), not an unrelated
 * process squatting the port. `issue_create`/`inbox_read` reachability is a separate, later
 * concern that needs a workspace id (Argus's OpenAliceAdapter/OpenAliceWorkspace handle that at
 * runtime, once this process is actually up) — see OpenAliceWorkspace.ts for why.
 */
async function startOpenAliceGuardian(): Promise<string | null> {
  const openAlicePath = ensureOpenAliceCheckout();
  if (!openAlicePath) return null;

  if (await mcpEndpointAccepting(GUARDIAN_MCP_URL)) {
    // Real bug fix (2026-08-18), corrected same day: an MCP responding to `initialize` is not
    // proof it's OpenAlice at all - confirm identity via serverInfo.name before deferring. (An
    // earlier version of this check required issue_create/inbox_read via tools/list, but those
    // are workspace-scoped in OpenAlice - see OpenAliceWorkspace.ts - and can never appear on
    // this bare URL, so that check would reject every healthy Guardian boot.)
    const identity = await mcpEndpointIsOpenAlice(GUARDIAN_MCP_URL);
    if (identity.ok) {
      console.log(`[dev] OpenAlice Guardian MCP already accepting at ${GUARDIAN_MCP_URL} - not starting a second pnpm dev. ${identity.reason}`);
      return GUARDIAN_MCP_URL;
    }
    openAliceLaunchError =
      `${identity.reason} Stop whatever is bound to port ${GUARDIAN_MCP_PORT} (likely an unrelated process), ` +
      `or set OPENALICE_HOME to isolate this launch, then re-run npm run dev. ${openAliceHowToEnable(openAlicePath)}`;
    console.warn(`[dev] ${openAliceLaunchError}`);
    return GUARDIAN_MCP_URL;
  }

  if (await isPortOpen(GUARDIAN_MCP_PORT)) {
    console.log(`[dev] Port ${GUARDIAN_MCP_PORT} is open but ${GUARDIAN_MCP_URL} is not accepting MCP yet — waiting (up to 60s)...`);
    const ready = await waitForOpenAliceMcp(GUARDIAN_MCP_URL, 60_000, console.warn);
    if (ready) {
      const identity = await mcpEndpointIsOpenAlice(GUARDIAN_MCP_URL);
      if (identity.ok) {
        console.log(`[dev] OpenAlice Guardian MCP is ready at ${GUARDIAN_MCP_URL}. ${identity.reason}`);
        return GUARDIAN_MCP_URL;
      }
      openAliceLaunchError = identity.reason + ` ${openAliceHowToEnable(openAlicePath)}`;
      console.warn(`[dev] ${openAliceLaunchError}`);
      return GUARDIAN_MCP_URL;
    }
    openAliceLaunchError =
      `Port ${GUARDIAN_MCP_PORT} is occupied but ${GUARDIAN_MCP_URL} did not accept MCP initialize. ` +
      `The other process may have MCP disabled (OpenAlice requires OPENALICE_MCP_ENABLED=1, the string "1"). ` +
      `Stop that instance or isolate with OPENALICE_HOME, then re-run npm run dev. ${openAliceHowToEnable(openAlicePath)}`;
    console.warn(`[dev] ${openAliceLaunchError}`);
    return GUARDIAN_MCP_URL;
  }

  const pnpmCmd = pnpmBin();
  if (!pnpmCmd) {
    openAliceLaunchError =
      `pnpm is not on PATH. OpenAlice requires pnpm (packageManager pnpm@11). ` +
      `Install with \`corepack enable\` then \`corepack prepare pnpm@11.7.0 --activate\`, and re-run npm run dev. ` +
      openAliceHowToEnable(openAlicePath);
    console.warn(`[dev] ${openAliceLaunchError}`);
    return null;
  }

  if (!ensureOpenAliceDeps(openAlicePath, pnpmCmd)) return null;

  const envOverrides: Record<string, string> = {
    // OpenAlice main.ts enables MCP only when this is the string "1" (not "true").
    OPENALICE_MCP_ENABLED: '1',
    OPENALICE_MCP_PORT: String(GUARDIAN_MCP_PORT),
    OPENALICE_WEB_PORT: String(GUARDIAN_WEB_PORT),
    // Research/verification only — skip OpenAlice UTA so Argus never talks to a trading MCP.
    OPENALICE_LITE_MODE: '1',
  };

  const envUrl = process.env.OPENALICE_MCP_URL?.trim();
  if (envUrl && envUrl !== GUARDIAN_MCP_URL && process.env.ARGUS_KEEP_OPENALICE_MCP_URL === 'true') {
    console.warn(`[dev] ARGUS_KEEP_OPENALICE_MCP_URL=true - leaving OPENALICE_MCP_URL=${envUrl} (Argus will FAIL if that MCP lacks issue_create/inbox_read).`);
  } else if (envUrl && envUrl !== GUARDIAN_MCP_URL) {
    console.warn(
      `[dev] OPENALICE_MCP_URL=${envUrl} is not Guardian (${GUARDIAN_MCP_URL}). Argus will use Guardian for verification so a trading MCP (placeOrder/getQuote) is not treated as OpenAlice.`
    );
  }

  const spawnArgs = pnpmCmd === 'corepack' ? ['pnpm', 'dev'] : ['dev'];
  console.log(`[dev] Starting OpenAlice Guardian from ${openAlicePath} (${pnpmCmd} ${spawnArgs.join(' ')}; MCP ${GUARDIAN_MCP_URL})`);
  const openAlice = spawn(pnpmCmd, spawnArgs, {
    cwd: openAlicePath,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, ...envOverrides },
  });
  children.push(openAlice);

  let exitedEarly = false;
  openAlice.on('exit', (code, signal) => {
    exitedEarly = true;
    if (!shuttingDown) {
      const likelyAlreadyRunning = code === 2;
      const msg =
        `[dev] OpenAlice's Guardian process exited (code=${code}, signal=${signal})` +
        (likelyAlreadyRunning
          ? ` — another OpenAlice instance already owns ~/.openalice. Argus will probe ${GUARDIAN_MCP_URL}. If that MCP is down, stop the other instance or run \`pnpm dev --takeover\` in the OpenAlice checkout.`
          : ` unexpectedly. ${openAliceHowToEnable(openAlicePath)}`);
      console.warn(msg);
      if (!likelyAlreadyRunning) {
        openAliceLaunchError = msg.replace(/^\[dev\] /, '');
      }
    }
  });

  const ready = await waitForOpenAliceMcp(GUARDIAN_MCP_URL, 180_000, console.warn, () => exitedEarly);
  if (ready) {
    console.log(`[dev] OpenAlice Guardian MCP is ready at ${GUARDIAN_MCP_URL}`);
    return GUARDIAN_MCP_URL;
  }
  if (!exitedEarly) {
    openAliceLaunchError =
      `Guardian MCP did not become ready at ${GUARDIAN_MCP_URL} within 180s. Watch the OpenAlice log above. ` +
      openAliceHowToEnable(openAlicePath);
    console.warn(`[dev] ${openAliceLaunchError}`);
  } else if (!openAliceLaunchError) {
    const mcpStillUp = await mcpEndpointAccepting(GUARDIAN_MCP_URL);
    if (mcpStillUp) {
      console.log(`[dev] Guardian process exited but ${GUARDIAN_MCP_URL} is accepting MCP (existing instance).`);
      return GUARDIAN_MCP_URL;
    }
    openAliceLaunchError =
      `OpenAlice Guardian exited before ${GUARDIAN_MCP_URL} accepted MCP. ` + openAliceHowToEnable(openAlicePath);
    console.warn(`[dev] ${openAliceLaunchError}`);
  }
  return GUARDIAN_MCP_URL;
}

function looksLikeIbkrGatewayDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'bin', 'run.bat')) && fs.existsSync(path.join(dir, 'root', 'conf.yaml'));
}

function findIbkrGatewayPath(): string | null {
  const fromEnv = process.env.IBKR_GATEWAY_PATH?.trim();
  if (fromEnv && looksLikeIbkrGatewayDir(fromEnv)) return fromEnv;
  if (fromEnv) {
    console.warn(`[dev] IBKR_GATEWAY_PATH="${fromEnv}" is set but missing bin/run.bat or root/conf.yaml.`);
  }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    'C:\\clientportal.gw',
    'C:\\IBKR\\clientportal.gw',
    'C:\\Jts\\clientportal.gw',
    path.join(home, 'clientportal.gw'),
    path.join(home, 'Downloads', 'clientportal.gw'),
    path.join(home, 'Downloads', 'clientportal'),
  ];
  for (const dir of candidates) {
    if (dir && looksLikeIbkrGatewayDir(dir)) {
      console.log(`[dev] Found IBKR Client Portal Gateway at ${dir} (IBKR_GATEWAY_PATH was empty).`);
      return dir;
    }
  }
  return null;
}

/** Finds a real java.exe without assuming it's on PATH - it wasn't, on this machine, in either
 *  Git Bash or PowerShell, despite the Gateway needing it. Checks JAVA_HOME first, then the
 *  standard Windows install locations, in the order a real install is most likely to land in. */
function findJavaHomeBin(): string | null {
  if (process.env.JAVA_HOME) {
    const candidate = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (fs.existsSync(candidate)) return path.dirname(candidate);
  }
  const searchRoots = ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium'];
  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name)); // prefer the newest-looking version string
    for (const entry of entries) {
      const candidate = path.join(root, entry.name, 'bin', 'java.exe');
      if (fs.existsSync(candidate)) return path.join(root, entry.name, 'bin');
    }
  }
  return null;
}

function readIbkrListenPort(confFile: string): number {
  try {
    const confText = fs.readFileSync(confFile, 'utf-8');
    const match = confText.match(/listenPort:\s*(\d+)/);
    if (match) return Number(match[1]);
  } catch {
    // fall through
  }
  return 5000;
}

async function startIbkrGateway(): Promise<void> {
  const ibkrPath = findIbkrGatewayPath();
  const defaultPort = (() => {
    try {
      const u = new URL(process.env.IBKR_GATEWAY_URL || 'https://localhost:5000/v1/api');
      return Number(u.port) || 5000;
    } catch {
      return 5000;
    }
  })();

  if (!ibkrPath) {
    if (await isPortOpen(defaultPort)) {
      console.log(`[dev] IBKR Gateway already reachable on port ${defaultPort}. Opening the login page (2FA is manual).`);
      openUrlInBrowser(`https://localhost:${defaultPort}`);
      return;
    }
    console.log(
      '[dev] IBKR Client Portal Gateway not found. Download it from Interactive Brokers, extract it, set IBKR_GATEWAY_PATH to that folder (must contain bin/run.bat), then re-run npm run dev. 2FA cannot be automated.'
    );
    return;
  }

  const runScript = path.join(ibkrPath, 'bin', 'run.bat');
  const confFile = path.join(ibkrPath, 'root', 'conf.yaml');
  if (!fs.existsSync(runScript) || !fs.existsSync(confFile)) {
    console.warn(`[dev] IBKR path "${ibkrPath}" is missing bin/run.bat or root/conf.yaml. Skipping.`);
    return;
  }

  const gatewayPort = readIbkrListenPort(confFile);
  const loginUrl = `https://localhost:${gatewayPort}`;

  if (await isPortOpen(gatewayPort)) {
    console.log(`[dev] IBKR Client Portal Gateway already reachable on port ${gatewayPort} - not starting a second instance.`);
    openUrlInBrowser(loginUrl);
    return;
  }

  const javaBin = findJavaHomeBin();
  const spawnEnv = { ...process.env };
  if (javaBin) {
    spawnEnv.PATH = `${javaBin};${process.env.PATH || ''}`;
  } else {
    console.warn('[dev] Could not find a real java.exe (checked JAVA_HOME, C:\\Program Files\\Java, C:\\Program Files\\Eclipse Adoptium) - attempting to start the IBKR Gateway anyway via whatever "java" resolves to on PATH, which may fail.');
  }

  console.log(`[dev] Starting IBKR Client Portal Gateway from ${ibkrPath} (port ${gatewayPort})`);
  const ibkr = spawn(`bin\\run.bat root\\conf.yaml`, {
    cwd: ibkrPath,
    shell: true,
    stdio: 'inherit',
    env: spawnEnv,
  });
  children.push(ibkr);

  ibkr.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.warn(`[dev] IBKR Client Portal Gateway exited unexpectedly (code=${code}, signal=${signal}).`);
    }
  });

  const up = await waitForPort(gatewayPort, 45_000, 'IBKR Client Portal Gateway');
  if (up) {
    openUrlInBrowser(loginUrl);
    console.log(`[dev] Complete IBKR login + 2FA in the browser (~24h session). This cannot be automated.`);
  } else {
    console.warn(`[dev] Gateway port ${gatewayPort} did not open. When it does, open ${loginUrl} and complete 2FA.`);
  }
}

function startTradingPlatform(childEnv: NodeJS.ProcessEnv): void {
  const server = spawn('node --use-system-ca ./node_modules/tsx/dist/cli.mjs server.ts', {
    cwd: repoRoot,
    shell: true,
    stdio: 'inherit',
    env: { ...childEnv, NODE_OPTIONS: [childEnv.NODE_OPTIONS, '--use-system-ca'].filter(Boolean).join(' ') },
  });
  children.push(server);

  server.on('exit', (code) => {
    killAll('SIGTERM');
    process.exit(code ?? 0);
  });
}

async function main() {
  if (process.env.ARGUS_SKIP_OLLAMA === 'true') {
    console.log('[dev] ARGUS_SKIP_OLLAMA=true - not starting Ollama.');
  } else {
    await startOllama();
  }

  const skipChronos = process.env.ARGUS_SKIP_CHRONOS === 'true';
  if (skipChronos) {
    console.log('[dev] ARGUS_SKIP_CHRONOS=true - Kronos stays KRONOS_UNAVAILABLE until you run npm run ai:serve.');
  }

  const skipOpenAlice = shouldSkipOpenAlice();
  if (skipOpenAlice) {
    console.log(`[dev] ${openAliceSkipReason()}`);
  }

  const [, guardianMcpUrl] = await Promise.all([
    skipChronos ? Promise.resolve() : startChronosAndWait(),
    skipOpenAlice ? Promise.resolve(null) : startOpenAliceGuardian(),
  ]);

  if (process.env.ARGUS_SKIP_IBKR === 'true') {
    console.log('[dev] ARGUS_SKIP_IBKR=true - not starting IBKR Gateway.');
  } else {
    await startIbkrGateway();
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ARGUS_START_LOCAL_MODELS: process.env.ARGUS_START_LOCAL_MODELS === 'false' ? 'false' : 'true',
    ARGUS_START_CHRONOS: process.env.ARGUS_SKIP_CHRONOS === 'true' ? 'false' : 'true',
    ARGUS_PROBE_IBKR: process.env.ARGUS_PROBE_IBKR === 'false' ? 'false' : 'true',
    LOCAL_AI_SERVICE_PORT: process.env.LOCAL_AI_SERVICE_PORT || '8008',
    LOCAL_AI_SERVICE_URL: preferIpv4Loopback(
      (process.env.LOCAL_AI_SERVICE_URL || 'http://127.0.0.1:8008').replace(/:8000(?=\/|$)/, ':8008'),
    ),
  };

  if (!skipOpenAlice && process.env.ARGUS_KEEP_OPENALICE_MCP_URL !== 'true') {
    childEnv.OPENALICE_ENABLED = 'true';
    childEnv.OPENALICE_MCP_URL = guardianMcpUrl || GUARDIAN_MCP_URL;
  }
  if (openAliceLaunchError) {
    childEnv.OPENALICE_LAUNCH_ERROR = openAliceLaunchError;
  }

  startTradingPlatform(childEnv);
}

main();
