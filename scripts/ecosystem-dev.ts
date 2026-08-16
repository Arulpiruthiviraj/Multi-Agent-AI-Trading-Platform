/**
 * ==========================================================
 * Script: ecosystem-dev.ts
 *
 * Purpose:
 * `npm run dev` process manager for Argus + optional sibling research repos.
 * Spawns isolated child processes only — does NOT merge foreign source into Argus,
 * does NOT touch RiskEngine / OMS / BrokerManager / EventBus.
 *
 * Flow:
 *   1. Load Argus root `.env` (central API keys + ecosystem paths).
 *   2. Optionally start Vibe-Trading MCP and AutoHedge (Python `.venv` binaries).
 *   3. Optionally start OpenAlice Guardian (pnpm), then skip duplicate spawn in core.
 *   4. Spawn `scripts/devWithOpenAlice.ts` (Chronos / Ollama / IBKR / `tsx server.ts`).
 *
 * Ctrl+C / SIGTERM kills every child PID this script started (Windows: taskkill /T).
 * Missing dirs or binaries log a warning and continue — Argus still boots.
 * ==========================================================
 */
import 'dotenv/config';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

type TrackedChild = {
  name: string;
  child: ChildProcess;
  pid: number;
};

const tracked: TrackedChild[] = [];
let shuttingDown = false;

function envFlag(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function log(msg: string): void {
  console.log(`[ecosystem] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[ecosystem] ${msg}`);
}

/** Resolve the repo-local venv Python without shell activation. */
function resolveVenvPython(dirPath: string): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(dirPath, '.venv', 'Scripts', 'python.exe'),
          path.join(dirPath, 'venv', 'Scripts', 'python.exe'),
        ]
      : [
          path.join(dirPath, '.venv', 'bin', 'python'),
          path.join(dirPath, '.venv', 'bin', 'python3'),
          path.join(dirPath, 'venv', 'bin', 'python'),
          path.join(dirPath, 'venv', 'bin', 'python3'),
        ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Resolve a console script next to the venv Python (e.g. vibe-trading-mcp.exe). */
function resolveVenvScript(dirPath: string, scriptBase: string): string | null {
  const binDir =
    process.platform === 'win32'
      ? path.join(dirPath, '.venv', 'Scripts')
      : path.join(dirPath, '.venv', 'bin');
  const names =
    process.platform === 'win32'
      ? [`${scriptBase}.exe`, `${scriptBase}.cmd`, scriptBase]
      : [scriptBase];
  for (const name of names) {
    const full = path.join(binDir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function killTracked(signal: NodeJS.Signals = 'SIGTERM'): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down ${tracked.length} child process(es) (${signal})...`);
  for (const entry of [...tracked].reverse()) {
    const { name, child, pid } = entry;
    try {
      if (process.platform === 'win32') {
        // Kill the whole tree — Python/pnpm often leave grandchildren otherwise.
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else if (!child.killed) {
        child.kill(signal);
      }
      log(`Stopped ${name} (pid ${pid}).`);
    } catch (e: any) {
      warn(`Failed to stop ${name} (pid ${pid}): ${e?.message || e}`);
    }
  }
}

process.on('SIGINT', () => {
  killTracked('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', () => {
  killTracked('SIGTERM');
  process.exit(0);
});

function track(name: string, child: ChildProcess): void {
  if (!child.pid) {
    warn(`${name} spawned without a PID — cannot track for shutdown.`);
    return;
  }
  tracked.push({ name, child, pid: child.pid });
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      warn(`${name} exited (code=${code}, signal=${signal}).`);
    }
  });
}

/**
 * Spawn a Python-backed service using the repo `.venv` interpreter (or a named console script).
 * Returns false on soft failure (missing path / python) so Argus can still start.
 */
function spawnPythonService(
  serviceName: string,
  dirPath: string | undefined,
  moduleOrCommand: string | string[],
  options?: {
    port?: number;
    env?: NodeJS.ProcessEnv;
    /** Prefer a venv console script (e.g. vibe-trading-mcp) over `python -m ...`. */
    preferScript?: string;
  },
): boolean {
  const resolvedDir = (dirPath || '').trim();
  if (!resolvedDir) {
    warn(`${serviceName}: path env is empty — skip.`);
    return false;
  }
  if (!fs.existsSync(resolvedDir)) {
    warn(`${serviceName}: directory does not exist (${resolvedDir}) — skip.`);
    return false;
  }

  const python = resolveVenvPython(resolvedDir);
  if (!python) {
    warn(
      `${serviceName}: no .venv Python under ${resolvedDir}. Create one (python -m venv .venv && pip install ...) then re-run. Skipping.`,
    );
    return false;
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options?.env || {}),
  };
  if (options?.port != null) {
    childEnv.PORT = String(options.port);
  }

  let cmd = python;
  let args: string[];

  if (options?.preferScript) {
    const script = resolveVenvScript(resolvedDir, options.preferScript);
    if (script) {
      cmd = script;
      args = Array.isArray(moduleOrCommand) ? moduleOrCommand : moduleOrCommand.split(/\s+/).filter(Boolean);
    } else {
      // Fall back to python -m <module> when console script is missing.
      const mod = Array.isArray(moduleOrCommand) ? moduleOrCommand : moduleOrCommand.split(/\s+/).filter(Boolean);
      if (mod[0] === '-m' || mod[0]?.includes('.')) {
        args = mod[0] === '-m' ? mod : ['-m', ...mod];
      } else {
        args = ['-m', options.preferScript.replace(/-/g, '_')];
        warn(`${serviceName}: console script '${options.preferScript}' not found; trying python -m fallback may fail.`);
      }
      cmd = python;
      if (!args) args = [];
    }
  } else {
    args = Array.isArray(moduleOrCommand) ? moduleOrCommand : moduleOrCommand.split(/\s+/).filter(Boolean);
  }

  log(`Starting ${serviceName} in ${resolvedDir} → ${cmd} ${args.join(' ')}`);
  const child = spawn(cmd, args, {
    cwd: resolvedDir,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  track(serviceName, child);
  return true;
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

function resolvePnpmCommand(): string | null {
  if (commandWorks('pnpm', ['--version'])) return 'pnpm';
  if (process.platform === 'win32' && commandWorks('pnpm.cmd', ['--version'])) return 'pnpm.cmd';
  if (commandWorks('corepack', ['--version'])) return 'corepack';
  return null;
}

/**
 * OpenAlice Guardian (Node/pnpm). Research/verification only — lite mode, no trading MCP.
 * Returns the Guardian MCP URL when spawn was attempted/already up, else null.
 */
function spawnOpenAlice(openAlicePath: string): string | null {
  const GUARDIAN_MCP_PORT = Number(process.env.OPENALICE_MCP_PORT || '47332');
  const GUARDIAN_WEB_PORT = Number(process.env.OPENALICE_WEB_PORT || '47331');
  const GUARDIAN_MCP_URL = `http://127.0.0.1:${GUARDIAN_MCP_PORT}/mcp`;

  if (!fs.existsSync(openAlicePath) || !fs.existsSync(path.join(openAlicePath, 'package.json'))) {
    warn(`OpenAlice: checkout missing or incomplete at ${openAlicePath} — skip.`);
    return null;
  }

  const pnpmCmd = resolvePnpmCommand();
  if (!pnpmCmd) {
    warn('OpenAlice: pnpm not on PATH — skip Guardian spawn.');
    return null;
  }

  const spawnArgs = pnpmCmd === 'corepack' ? ['pnpm', 'dev'] : ['dev'];
  log(`Starting OpenAlice Guardian from ${openAlicePath} (${pnpmCmd} ${spawnArgs.join(' ')})`);
  const child = spawn(pnpmCmd, spawnArgs, {
    cwd: openAlicePath,
    shell: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      OPENALICE_MCP_ENABLED: '1',
      OPENALICE_MCP_PORT: String(GUARDIAN_MCP_PORT),
      OPENALICE_WEB_PORT: String(GUARDIAN_WEB_PORT),
      OPENALICE_LITE_MODE: '1',
    },
  });
  track('OpenAlice', child);
  return GUARDIAN_MCP_URL;
}

function startArgusCore(extraEnv: NodeJS.ProcessEnv): void {
  const coreScript = path.join(repoRoot, 'scripts', 'devWithOpenAlice.ts');
  log(`Starting Argus core (Chronos/Ollama/IBKR + Express/Vite) via ${coreScript}`);
  const child = spawn('npx', ['tsx', coreScript], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
  });
  track('Argus-core', child);
  child.on('exit', (code) => {
    killTracked('SIGTERM');
    process.exit(code ?? 0);
  });
}

function main(): void {
  log('Ecosystem orchestrator starting (external services are optional; Argus always boots).');

  const vibePath = process.env.VIBE_TRADING_PATH || path.resolve(repoRoot, '..', 'vibe-trading');
  const autohedgePath = process.env.AUTOHEDGE_PATH || path.resolve(repoRoot, '..', 'autohedge');
  const openAlicePath =
    process.env.OPENALICE_PATH ||
    process.env.OPENALICE_REPO_PATH ||
    path.resolve(repoRoot, '..', 'OpenAlice');

  const coreEnv: NodeJS.ProcessEnv = {
    OPENALICE_REPO_PATH: openAlicePath,
  };

  // --- Vibe-Trading MCP (research only; never wired into RiskEngine/OMS) ---
  if (envFlag('ENABLE_VIBE_TRADING_MCP', false)) {
    const port = Number(process.env.VIBE_TRADING_MCP_PORT || '8900');
    const defaultArgs = ['--transport', 'http', '--port', String(port)];
    const argOverride = process.env.VIBE_TRADING_MCP_ARGS?.trim();
    const mcpArgs = argOverride ? argOverride.split(/\s+/).filter(Boolean) : defaultArgs;
    spawnPythonService('Vibe-Trading-MCP', vibePath, mcpArgs, {
      port,
      preferScript: 'vibe-trading-mcp',
      env: {
        // Pass Argus-central keys into the child (do not require a second .env).
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || '',
        GROQ_API_KEY: process.env.GROQ_API_KEY || '',
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
      },
    });
  } else {
    log('ENABLE_VIBE_TRADING_MCP is off — skip Vibe-Trading.');
  }

  // --- AutoHedge (analysis worker only; wallet keys forcibly emptied) ---
  if (envFlag('ENABLE_AUTOHEDGE_WORKER', false)) {
    const cmdOverride = process.env.AUTOHEDGE_CMD?.trim();
    const args = cmdOverride
      ? cmdOverride.split(/\s+/).filter(Boolean)
      : []; // empty → use preferScript `autohedge`
    spawnPythonService('AutoHedge', autohedgePath, args.length ? args : ['--help'], {
      preferScript: 'autohedge',
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
        JUPITER_API_KEY: process.env.JUPITER_API_KEY || '',
        // CRITICAL: never allow trade execution from this orchestrator.
        WALLET_PRIVATE_KEY: '',
        SOLANA_PRIVATE_KEY: '',
        AUTOHEDGE_PAPER_ONLY: 'true',
        WORKSPACE_DIR: process.env.AUTOHEDGE_WORKSPACE_DIR || path.join(autohedgePath, 'agent_workspace'),
      },
    });
  } else {
    log('ENABLE_AUTOHEDGE_WORKER is off — skip AutoHedge.');
  }

  // --- OpenAlice Guardian ---
  // If we spawn it here, tell devWithOpenAlice not to spawn a second copy.
  if (envFlag('ENABLE_OPENALICE', true) && process.env.ARGUS_SKIP_OPENALICE !== 'true') {
    const url = spawnOpenAlice(openAlicePath);
    if (url) {
      coreEnv.ARGUS_SKIP_OPENALICE = 'true';
      coreEnv.OPENALICE_ENABLED = 'true';
      if (process.env.ARGUS_KEEP_OPENALICE_MCP_URL !== 'true') {
        coreEnv.OPENALICE_MCP_URL = url;
      }
    }
  } else {
    log('OpenAlice spawn skipped (ENABLE_OPENALICE=false or ARGUS_SKIP_OPENALICE=true).');
  }

  startArgusCore(coreEnv);
}

main();
