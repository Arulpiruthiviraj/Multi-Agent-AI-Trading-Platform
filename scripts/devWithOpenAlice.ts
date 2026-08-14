/**
 * ==========================================================
 * Script: devWithOpenAlice.ts
 *
 * Purpose:
 * `npm run dev`'s real entry point. Starts the trading platform's own dev server exactly as
 * before (`tsx server.ts`), and additionally starts up to two external companion processes when
 * configured, so nobody has to remember to start them by hand in separate terminals:
 *
 *   1. OpenAlice's Guardian dev stack (MCP enabled) - when `OPENALICE_ENABLED=true` (the existing
 *      flag already read by OpenAliceVerificationService, see
 *      src/server/integrations/openalice/), so `OPENALICE_MCP_URL` has something real listening.
 *   2. IBKR's Client Portal Gateway (the local Java process InteractiveBrokersAdapter.ts talks
 *      to) - when `IBKR_GATEWAY_PATH` is set, via the Gateway's own `bin/run.bat`. This does NOT
 *      complete the browser 2FA login for you - that remains a real, un-automatable manual step
 *      IBKR itself requires roughly every 24h (see InteractiveBrokersAdapter.ts's own header
 *      comment) - it just gets the process up and listening so the login page is reachable.
 *
 * Behavior for anyone who has set neither flag is unchanged: this reduces to exactly
 * `tsx server.ts`, same as before this script existed.
 *
 * Configuration:
 *   OPENALICE_REPO_PATH - absolute path to a local OpenAlice checkout. Defaults to a sibling
 *   `OpenAlice` directory next to this repo (this developer's actual layout).
 *   IBKR_GATEWAY_PATH - absolute path to a local IBKR Client Portal Gateway install (the folder
 *   containing bin/run.bat and root/conf.yaml). No default - must be set explicitly, since unlike
 *   OpenAlice there's no repo-relative convention to guess from.
 *
 * Ctrl+C (or any other termination signal) here kills every process this script itself started -
 * the previous manual multi-terminal workflow left companion processes orphaned and running if
 * you only closed the trading-platform terminal. It deliberately does NOT kill a Gateway/OpenAlice
 * instance this script did not start itself (see the "already running" checks below) - Ctrl+C-ing
 * this script should never yank away a session you started by hand in a different terminal.
 * ==========================================================
 */
import 'dotenv/config';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const children: ChildProcess[] = [];
let shuttingDown = false;

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

function startOpenAlice(): void {
  const openAlicePath = process.env.OPENALICE_REPO_PATH || path.resolve(repoRoot, '..', 'OpenAlice');

  if (!fs.existsSync(openAlicePath) || !fs.existsSync(path.join(openAlicePath, 'package.json'))) {
    console.warn(
      `[dev] OPENALICE_ENABLED=true but no OpenAlice checkout found at ${openAlicePath}. ` +
      `Set OPENALICE_REPO_PATH in .env to the correct path. Continuing without it - ` +
      `OPENALICE_MCP_URL will have nothing real listening on the other end.`
    );
    return;
  }

  // Real bug found by actually running this the first time: Guardian auto-selects the next free
  // port when its default (47331/47332) is taken, which this session's own OpenAlice work already
  // demonstrated lands on a DIFFERENT port every boot (3002/3003 was observed once). Left alone,
  // that silently strands OPENALICE_MCP_URL pointing at a port nothing is listening on. Pin both
  // ports explicitly, parsed from OPENALICE_MCP_URL itself (not a second hardcoded value that
  // could drift from it) - OPENALICE_WEB_PORT = mcpPort - 1, matching Guardian's own convention
  // (scripts/guardian/shared.ts: `mcp` claims from `web + 1`).
  const envOverrides: Record<string, string> = { OPENALICE_MCP_ENABLED: '1' };
  const mcpUrl = process.env.OPENALICE_MCP_URL;
  if (mcpUrl) {
    try {
      const mcpPort = Number(new URL(mcpUrl).port);
      if (Number.isInteger(mcpPort) && mcpPort > 0) {
        envOverrides.OPENALICE_MCP_PORT = String(mcpPort);
        envOverrides.OPENALICE_WEB_PORT = String(mcpPort - 1);
      }
    } catch {
      console.warn(`[dev] Could not parse a port out of OPENALICE_MCP_URL="${mcpUrl}" - letting Guardian pick its own port, which may not match this URL.`);
    }
  }

  console.log(`[dev] OPENALICE_ENABLED=true - starting OpenAlice's Guardian dev stack (MCP enabled) from ${openAlicePath}`);
  // A single command string, not a separate args array - Node 24 deprecates (DEP0190) passing an
  // args array alongside shell:true, since the args are concatenated unescaped either way.
  const openAlice = spawn('pnpm dev', {
    cwd: openAlicePath,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, ...envOverrides },
  });
  children.push(openAlice);

  openAlice.on('exit', (code, signal) => {
    if (!shuttingDown) {
      // Real observed case, not hypothetical: Guardian's own single-instance ownership lock
      // refuses to start a second guardian-dev and exits 2 with a clear message of its own
      // ("already running as pid ...") when a prior instance (e.g. from a previous session) still
      // holds it - that's expected and fine, the existing instance is the real MCP server. Any
      // other exit code is a genuine, not-yet-explained failure.
      const likelyAlreadyRunning = code === 2;
      console.warn(
        `[dev] OpenAlice's Guardian process exited (code=${code}, signal=${signal})` +
        (likelyAlreadyRunning
          ? ` - likely because another instance already owns it (see its own log lines above); if so this is expected and that existing instance is the real MCP server.`
          : ` unexpectedly.`) +
        ` The trading platform keeps running either way - OpenAlice verification will just report unreachable if nothing real is actually listening.`
      );
    }
  });
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

async function startIbkrGateway(): Promise<void> {
  const ibkrPath = process.env.IBKR_GATEWAY_PATH;
  if (!ibkrPath) return;

  const runScript = path.join(ibkrPath, 'bin', 'run.bat');
  const confFile = path.join(ibkrPath, 'root', 'conf.yaml');
  if (!fs.existsSync(runScript) || !fs.existsSync(confFile)) {
    console.warn(`[dev] IBKR_GATEWAY_PATH="${ibkrPath}" is set but doesn't look like a real Client Portal Gateway install (missing bin/run.bat or root/conf.yaml). Skipping.`);
    return;
  }

  // conf.yaml's own listenPort - read for real rather than assuming 5000, though 5000 is the
  // Gateway's documented default and what InteractiveBrokersAdapter.ts's own fallback URL uses.
  let gatewayPort = 5000;
  try {
    const confText = fs.readFileSync(confFile, 'utf-8');
    const match = confText.match(/listenPort:\s*(\d+)/);
    if (match) gatewayPort = Number(match[1]);
  } catch {
    // Real conf file exists (checked above) but couldn't be parsed for a port - fall back to the
    // documented default rather than blocking startup over a cosmetic read failure.
  }

  if (await isPortOpen(gatewayPort)) {
    console.log(`[dev] IBKR Client Portal Gateway already reachable on port ${gatewayPort} (started outside this script) - not starting a second instance. A second Gateway process would fight the first for the same brokerage session.`);
    return;
  }

  const javaBin = findJavaHomeBin();
  const spawnEnv = { ...process.env };
  if (javaBin) {
    spawnEnv.PATH = `${javaBin};${process.env.PATH || ''}`;
  } else {
    console.warn('[dev] Could not find a real java.exe (checked JAVA_HOME, C:\\Program Files\\Java, C:\\Program Files\\Eclipse Adoptium) - attempting to start the IBKR Gateway anyway via whatever "java" resolves to on PATH, which may fail.');
  }

  console.log(`[dev] IBKR_GATEWAY_PATH is set - starting the Client Portal Gateway from ${ibkrPath} (port ${gatewayPort})`);
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

  // The Gateway takes a few seconds to bind its port; give it a moment before printing the
  // reminder below so it doesn't get lost in that startup noise.
  setTimeout(() => {
    console.log(`[dev] IBKR Gateway starting - once it's up, open https://localhost:${gatewayPort} in a browser and complete login (2FA required, roughly every 24h - this cannot be automated, see InteractiveBrokersAdapter.ts).`);
  }, 4000);
}

function startTradingPlatform(): void {
  const server = spawn('npx tsx server.ts', {
    cwd: repoRoot,
    shell: true,
    stdio: 'inherit',
  });
  children.push(server);

  server.on('exit', (code) => {
    // The trading platform is the primary process - once it exits (crash, or an explicit stop),
    // there is no reason to keep any companion process running for it.
    killAll('SIGTERM');
    process.exit(code ?? 0);
  });
}

async function main() {
  if (process.env.OPENALICE_ENABLED === 'true') {
    startOpenAlice();
  } else {
    console.log('[dev] OPENALICE_ENABLED is not "true" - skipping OpenAlice. Set OPENALICE_ENABLED=true in .env to also start it.');
  }

  if (process.env.IBKR_GATEWAY_PATH) {
    await startIbkrGateway();
  } else {
    console.log('[dev] IBKR_GATEWAY_PATH is not set - skipping the IBKR Gateway. Set it in .env to also start it.');
  }

  startTradingPlatform();
}

main();
