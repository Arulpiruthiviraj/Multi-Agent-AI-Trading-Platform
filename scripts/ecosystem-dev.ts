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
 *   2. Optionally start Vibe-Trading MCP, AutoHedge, and Fincept (Python `.venv` / explicit CMD).
 *   3. Pass OpenAlice checkout path into core. Core starts Guardian and waits for MCP
 *      readiness unless ENABLE_OPENALICE=false or ARGUS_SKIP_OPENALICE=true.
 *      Do not spawn-and-skip here — that left Diagnostics probing a port that was not up yet.
 *   4. Spawn `scripts/devWithOpenAlice.ts` (Chronos / Ollama / OpenAlice / IBKR / `tsx server.ts`).
 *
 * Ctrl+C / SIGTERM kills every child PID this script started (Windows: taskkill /T).
 * Missing dirs or binaries log a warning and continue — Argus still boots.
 *
 * Trust: Argus remains sole execution authority. External children are research/verification only.
 * AutoHedge always gets WALLET_PRIVATE_KEY="" / SOLANA_PRIVATE_KEY="".
 * ==========================================================
 */
import 'dotenv/config';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openAliceSkipReason, shouldSkipOpenAlice } from './openAliceDevSupport';

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
 *
 * Resolution order:
 *   1. `.venv/Scripts|<bin>/<preferScript>` if preferScript is set and exists
 *   2. `.venv` python + `args` (e.g. `-m vibe_trading.mcp ...`)
 */
function spawnPythonService(
  serviceName: string,
  dirPath: string | undefined,
  args: string[],
  options?: {
    port?: number;
    env?: NodeJS.ProcessEnv;
    /** Prefer a venv console script (e.g. vibe-trading-mcp) over python -m. */
    preferScript?: string;
    /** When console script is missing, run `python -m <fallbackModule> ...args`. */
    fallbackModule?: string;
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
  let spawnArgs = [...args];

  if (options?.preferScript) {
    const script = resolveVenvScript(resolvedDir, options.preferScript);
    if (script) {
      cmd = script;
      spawnArgs = [...args];
    } else if (options.fallbackModule) {
      warn(
        `${serviceName}: console script '${options.preferScript}' not in .venv — falling back to python -m ${options.fallbackModule}.`,
      );
      cmd = python;
      spawnArgs = ['-m', options.fallbackModule, ...args];
    } else {
      warn(
        `${serviceName}: console script '${options.preferScript}' not found under .venv and no fallbackModule — skip.`,
      );
      return false;
    }
  }

  log(`Starting ${serviceName} in ${resolvedDir} → ${cmd} ${spawnArgs.join(' ')}`);
  const child = spawn(cmd, spawnArgs, {
    cwd: resolvedDir,
    env: childEnv,
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
  });
  track(serviceName, child);
  return true;
}

function startArgusCore(extraEnv: NodeJS.ProcessEnv): void {
  const coreScript = path.join(repoRoot, 'scripts', 'devWithOpenAlice.ts');
  log(`Starting Argus core (Chronos/Ollama/OpenAlice/IBKR + Express/Vite) via ${coreScript}`);
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
      fallbackModule: 'vibe_trading.mcp',
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
    const args = cmdOverride ? cmdOverride.split(/\s+/).filter(Boolean) : [];
    spawnPythonService('AutoHedge', autohedgePath, args, {
      preferScript: 'autohedge',
      fallbackModule: 'autohedge',
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

  // --- FinceptTerminal (optional research UI; no invented default CLI) ---
  if (envFlag('ENABLE_FINCEPT_TERMINAL', false)) {
    const finceptPath =
      process.env.FINCEPT_TERMINAL_PATH || path.resolve(repoRoot, '..', 'FinceptTerminal');
    const finceptCmd = process.env.FINCEPT_CMD?.trim();
    if (!finceptCmd) {
      warn(
        'ENABLE_FINCEPT_TERMINAL=true but FINCEPT_CMD is empty — skip (refuse invented default binary). See README.md (ecosystem).',
      );
    } else if (!fs.existsSync(finceptPath)) {
      warn(`FinceptTerminal: directory does not exist (${finceptPath}) — skip.`);
    } else {
      const parts = finceptCmd.split(/\s+/).filter(Boolean);
      const cmd = parts[0];
      const args = parts.slice(1);
      log(`Starting FinceptTerminal in ${finceptPath} → ${cmd} ${args.join(' ')}`);
      const child = spawn(cmd, args, {
        cwd: finceptPath,
        env: {
          ...process.env,
          // Research sidecar only — do not forward a trading mandate.
          FINCEPT_READ_ONLY: 'true',
        },
        stdio: 'inherit',
        windowsHide: true,
        shell: process.platform === 'win32',
      });
      track('FinceptTerminal', child);
    }
  } else {
    log('ENABLE_FINCEPT_TERMINAL is off — skip Fincept.');
  }

  // --- OpenAlice Guardian ---
  // Core (devWithOpenAlice.ts) clones/installs/starts Guardian and waits for MCP /mcp.
  // Spawn-and-set ARGUS_SKIP_OPENALICE here used to start Argus before :47332 was listening.
  if (shouldSkipOpenAlice()) {
    coreEnv.ARGUS_SKIP_OPENALICE = 'true';
    log(openAliceSkipReason() || 'OpenAlice spawn skipped.');
  } else {
    log(`OpenAlice Guardian will start from ${openAlicePath} (core waits for MCP http://127.0.0.1:47332/mcp).`);
  }

  startArgusCore(coreEnv);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main();
}
