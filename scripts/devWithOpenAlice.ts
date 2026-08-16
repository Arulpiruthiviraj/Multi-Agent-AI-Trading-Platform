/**
 * ==========================================================
 * Script: devWithOpenAlice.ts
 *
 * Purpose:
 * `npm run dev` entry point. Starts `tsx server.ts` plus local companions so Kronos is not left
 * KRONOS_UNAVAILABLE just because nobody ran `npm run ai:serve` in another terminal.
 *
 *   1. Chronos/Kronos + FinBERT (`scripts/local_ai_service.py` on LOCAL_AI_SERVICE_PORT, default
 *      8008) unless ARGUS_SKIP_CHRONOS=true. This is what KronosEngine / KronosForecastAgent call.
 *   2. Ollama (`ollama serve` on 11434) unless ARGUS_SKIP_OLLAMA=true or something already listens.
 *   3. OpenAlice Guardian (sibling checkout or OPENALICE_REPO_PATH) unless ARGUS_SKIP_OPENALICE=true.
 *      Argus is pointed at Guardian http://127.0.0.1:47332/mcp (issue_create / inbox_read), never at
 *      the UTA trading MCP. Override with ARGUS_KEEP_OPENALICE_MCP_URL=true.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const children: ChildProcess[] = [];
let shuttingDown = false;

/** OpenAlice Guardian MCP (issue_create / inbox_read). Not the UTA trading MCP on 47333. */
const GUARDIAN_MCP_PORT = 47332;
const GUARDIAN_WEB_PORT = 47331;
const GUARDIAN_MCP_URL = `http://127.0.0.1:${GUARDIAN_MCP_PORT}/mcp`;

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
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
  return r.status === 0;
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
  const healthUrl = `${preferIpv4Loopback(process.env.LOCAL_AI_SERVICE_URL || `http://127.0.0.1:${port}`)}/health`;

  if (await isPortOpen(port)) {
    console.log(`[dev] Chronos/Kronos local_ai_service already reachable on port ${port} - not starting a second copy.`);
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
 * Argus verification talks to Guardian (`issue_create` / `inbox_read` on :47332).
 * A URL that already lists placeOrder/getQuote is OpenAlice UTA (or another trading MCP),
 * not Guardian — pinning Guardian to that port would collide and keep Model Runtime FAILED.
 */
async function startOpenAliceGuardian(): Promise<string | null> {
  const openAlicePath = openAliceCheckoutPath();

  if (!fs.existsSync(openAlicePath) || !fs.existsSync(path.join(openAlicePath, 'package.json'))) {
    console.warn(
      `[dev] No OpenAlice checkout at ${openAlicePath}. Set OPENALICE_REPO_PATH or clone OpenAlice as a sibling folder. Skipping Guardian.`
    );
    return null;
  }

  if (await isPortOpen(GUARDIAN_MCP_PORT)) {
    console.log(`[dev] OpenAlice Guardian MCP already listening on ${GUARDIAN_MCP_PORT} - not starting a second pnpm dev.`);
    return GUARDIAN_MCP_URL;
  }

  if (!commandWorks('pnpm', ['--version'])) {
    console.warn('[dev] pnpm is not on PATH. Cannot start OpenAlice Guardian (`pnpm dev` in the OpenAlice checkout). Install pnpm, then re-run npm run dev.');
    return null;
  }

  const envOverrides: Record<string, string> = {
    OPENALICE_MCP_ENABLED: '1',
    OPENALICE_MCP_PORT: String(GUARDIAN_MCP_PORT),
    OPENALICE_WEB_PORT: String(GUARDIAN_WEB_PORT),
  };

  const envUrl = process.env.OPENALICE_MCP_URL?.trim();
  if (envUrl && envUrl !== GUARDIAN_MCP_URL && process.env.ARGUS_KEEP_OPENALICE_MCP_URL === 'true') {
    console.warn(`[dev] ARGUS_KEEP_OPENALICE_MCP_URL=true - leaving OPENALICE_MCP_URL=${envUrl} (Argus will FAIL if that MCP lacks issue_create/inbox_read).`);
  } else if (envUrl && envUrl !== GUARDIAN_MCP_URL) {
    console.warn(
      `[dev] OPENALICE_MCP_URL=${envUrl} is not Guardian (${GUARDIAN_MCP_URL}). Argus will use Guardian for verification so a trading MCP (placeOrder/getQuote) is not treated as OpenAlice.`
    );
  }

  console.log(`[dev] Starting OpenAlice Guardian from ${openAlicePath} (MCP ${GUARDIAN_MCP_URL})`);
  const openAlice = spawn('pnpm dev', {
    cwd: openAlicePath,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, ...envOverrides },
  });
  children.push(openAlice);

  openAlice.on('exit', (code, signal) => {
    if (!shuttingDown) {
      const likelyAlreadyRunning = code === 2;
      console.warn(
        `[dev] OpenAlice's Guardian process exited (code=${code}, signal=${signal})` +
        (likelyAlreadyRunning
          ? ` - likely because another instance already owns it; if so that existing instance is the MCP server.`
          : ` unexpectedly.`) +
        ` Argus keeps running; OpenAlice stays FAILED until Guardian tools issue_create and inbox_read are reachable.`
      );
    }
  });

  const up = await waitForPort(GUARDIAN_MCP_PORT, 60_000, 'OpenAlice Guardian MCP');
  if (!up) {
    console.warn('[dev] Guardian MCP port did not open in time. Argus will keep probing.');
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
  const server = spawn('npx tsx server.ts', {
    cwd: repoRoot,
    shell: true,
    stdio: 'inherit',
    env: childEnv,
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

  if (process.env.ARGUS_SKIP_CHRONOS === 'true') {
    console.log('[dev] ARGUS_SKIP_CHRONOS=true - Kronos stays KRONOS_UNAVAILABLE until you run npm run ai:serve.');
  } else {
    await startChronosAndWait();
  }

  let guardianMcpUrl: string | null = null;
  if (process.env.ARGUS_SKIP_OPENALICE === 'true') {
    console.log('[dev] ARGUS_SKIP_OPENALICE=true - skipping OpenAlice Guardian.');
  } else if (process.env.OPENALICE_ENABLED === 'true' || openAliceCheckoutExists()) {
    guardianMcpUrl = await startOpenAliceGuardian();
  } else {
    console.log('[dev] No OpenAlice checkout and OPENALICE_ENABLED is not true - skipping Guardian.');
  }

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
    LOCAL_AI_SERVICE_URL: preferIpv4Loopback(process.env.LOCAL_AI_SERVICE_URL || 'http://127.0.0.1:8008'),
  };

  if (guardianMcpUrl && process.env.ARGUS_KEEP_OPENALICE_MCP_URL !== 'true') {
    childEnv.OPENALICE_ENABLED = 'true';
    childEnv.OPENALICE_MCP_URL = guardianMcpUrl;
  }

  startTradingPlatform(childEnv);
}

main();
