#!/usr/bin/env node
/**
 * Argus CLI — HTTP client + optional process lifecycle for headless engine.
 * MUST NOT import RiskEngine, OMS, BrokerManager, or TradingEngine.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearEnginePid,
  isEngineProcessRunning,
  readEnginePid,
  writeEnginePid,
} from '../src/server/app/enginePid';

const BASE = process.env.ARGUS_API_URL || 'http://127.0.0.1:3000';
const ROOT = process.cwd();

async function fetchJson(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.ARGUS_DEV_TOKEN ? { 'x-argus-dev-token': process.env.ARGUS_DEV_TOKEN } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(typeof body === 'object' && body && 'error' in (body as object)
      ? String((body as { error: string }).error)
      : `HTTP ${res.status}`);
  }
  return body;
}

async function waitForHealth(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const h = await fetchJson('/api/v2/runtime/health') as { ok?: boolean };
      if (h.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function parseFlags(argv: string[]) {
  return {
    headless: argv.includes('--headless') || argv.includes('-H'),
    prod: argv.includes('--prod'),
  };
}

function parseReplayArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--capital' && argv[i + 1]) out.capital = argv[++i];
    else if (a === '--start' && argv[i + 1]) out.start = argv[++i];
    else if (a === '--end' && argv[i + 1]) out.end = argv[++i];
    else if (a === '--universe' && argv[i + 1]) out.universe = argv[++i];
    else if (a === '--symbols' && argv[i + 1]) out.symbols = argv[++i];
    else if (a === '--provider' && argv[i + 1]) out.provider = argv[++i];
    else if (!a.startsWith('--') && !out.runId) out.runId = a;
  }
  return out;
}

async function startEngine() {
  const flags = parseFlags(process.argv.slice(3));
  if (isEngineProcessRunning()) {
    console.log(JSON.stringify({ ok: true, message: 'Engine already running', pid: readEnginePid() }, null, 2));
    return;
  }
  const distServer = join(ROOT, 'dist', 'server.cjs');
  const useProd = flags.prod || existsSync(distServer);
  const env = { ...process.env, ARGUS_HEADLESS: 'true', ARGUS_ENGINE: 'true' };
  let child;
  if (useProd && existsSync(distServer)) {
    child = spawn(process.execPath, [join(ROOT, 'scripts', 'argus-engine-prod.mjs')], { cwd: ROOT, env, detached: true, stdio: 'ignore' });
  } else {
    const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    child = spawn(process.execPath, [tsx, join(ROOT, 'scripts', 'argus-engine.ts')], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: 'ignore',
    });
  }
  if (!child.pid) throw new Error('Failed to spawn Argus engine process');
  writeEnginePid(child.pid);
  child.unref();
  const ready = await waitForHealth();
  console.log(JSON.stringify({
    ok: ready,
    pid: child.pid,
    headless: true,
    api: BASE,
    message: ready ? 'Engine started' : 'Engine spawned but health check timed out',
  }, null, 2));
  if (!ready) process.exit(1);
}

async function stopEngine() {
  const pid = readEnginePid();
  if (!pid) {
    console.log(JSON.stringify({ ok: true, message: 'No engine PID file' }, null, 2));
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e: unknown) {
    clearEnginePid();
    throw e;
  }
  clearEnginePid();
  console.log(JSON.stringify({ ok: true, message: 'SIGTERM sent', pid }, null, 2));
}

const replayCommands: Record<string, () => Promise<void>> = {
  async list() {
    console.log(JSON.stringify(await fetchJson('/api/v2/historical-evaluations'), null, 2));
  },
  async run() {
    const args = parseReplayArgs(process.argv.slice(4));
    const universe = (args.universe || 'discovery').toLowerCase();
    const body: Record<string, unknown> = {
      initialCapital: Number(args.capital || 100000),
      allocationBudget: Number(args.capital || 100000),
      startDate: args.start || '2024-01-02',
      endDate: args.end || '2024-12-31',
      dataProvider: args.provider || 'golden_replay',
      aiMode: 'DISABLED',
      speed: 'MAX',
      randomSeed: 1,
    };
    if (universe === 'symbols' || universe === 'operator') {
      body.universeSource = 'OPERATOR_SELECTED';
      body.symbols = (args.symbols || 'AAPL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else {
      body.universeSource = 'ARGUS_DISCOVERY';
    }
    const created = await fetchJson('/api/v2/historical-evaluations', { method: 'POST', body: JSON.stringify(body) }) as { replayId?: string };
    if (!created.replayId) {
      console.log(JSON.stringify(created, null, 2));
      return;
    }
    console.log(JSON.stringify(await fetchJson(`/api/v2/research/replay/${created.replayId}/start?async=0`, { method: 'POST', body: '{}' }), null, 2));
  },
  async report() {
    const id = parseReplayArgs(process.argv.slice(4)).runId;
    if (!id) throw new Error('Usage: argus replay report <runId>');
    console.log(JSON.stringify(await fetchJson(`/api/v2/historical-evaluations/${id}/report`), null, 2));
  },
  async export() {
    const id = parseReplayArgs(process.argv.slice(4)).runId;
    if (!id) throw new Error('Usage: argus replay export <runId>');
    const res = await fetch(`${BASE}/api/v2/historical-evaluations/${id}/export?format=zip`, {
      headers: process.env.ARGUS_DEV_TOKEN ? { 'x-argus-dev-token': process.env.ARGUS_DEV_TOKEN } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    process.stdout.write(Buffer.from(await res.arrayBuffer()));
  },
};

const commands: Record<string, () => Promise<void>> = {
  async start() {
    return startEngine();
  },
  async stop() {
    return stopEngine();
  },
  async restart() {
    await stopEngine().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    return startEngine();
  },
  async status() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/status'), null, 2));
  },
  async health() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/health'), null, 2));
  },
  async config() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/config'), null, 2));
  },
  async positions() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/portfolio'), null, 2));
  },
  async portfolio() {
    return commands.positions();
  },
  async orders() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/orders'), null, 2));
  },
  async trades() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/trades'), null, 2));
  },
  async logs() {
    console.log(JSON.stringify(await fetchJson('/api/v2/system/logs/recent?limit=50'), null, 2));
  },
  async enable() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/trading/enable', { method: 'POST', body: '{}' }), null, 2));
  },
  async disable() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/trading/disable', { method: 'POST', body: '{}' }), null, 2));
  },
  async 'kill-switch'() {
    console.log(JSON.stringify(await fetchJson('/api/v1/system/emergency-stop', {
      method: 'POST',
      body: JSON.stringify({ reason: 'CLI emergency stop' }),
    }), null, 2));
  },
  async agents() {
    console.log(JSON.stringify(await fetchJson('/api/v1/system/pipeline-agents'), null, 2));
  },
  async events() {
    console.log(JSON.stringify(await fetchJson('/api/v2/system/events?limit=50'), null, 2));
  },
  async risk() {
    console.log(JSON.stringify(await fetchJson('/api/v2/runtime/risk/status'), null, 2));
  },
  async replay() {
    const sub = process.argv[3];
    if (!sub || sub === 'run' || sub.startsWith('--')) return replayCommands.run();
    const handler = replayCommands[sub];
    if (!handler) throw new Error(`Unknown replay subcommand: ${sub}`);
    return handler();
  },
};

const cmd = process.argv[2] || 'status';
if (!commands[cmd]) {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

commands[cmd]().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
