#!/usr/bin/env node
/**
 * Thin CLI client for a running Argus instance — HTTP adapter only, no trading logic.
 *
 * Usage:
 *   npx tsx scripts/argus-cli.ts status
 *   npx tsx scripts/argus-cli.ts replay --capital 2000 --start 2025-01-01 --end 2025-12-31
 *   npx tsx scripts/argus-cli.ts replay list
 *   npx tsx scripts/argus-cli.ts replay report <runId>
 */
const BASE = process.env.ARGUS_API_URL || 'http://127.0.0.1:3000';

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

const replayCommands: Record<string, () => Promise<void>> = {
  async status() {
    const data = await fetchJson('/api/v2/system/status');
    console.log(JSON.stringify(data, null, 2));
  },
  async list() {
    const data = await fetchJson('/api/v2/historical-evaluations');
    console.log(JSON.stringify(data, null, 2));
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
    const started = await fetchJson(`/api/v2/research/replay/${created.replayId}/start?async=0`, { method: 'POST', body: '{}' });
    console.log(JSON.stringify(started, null, 2));
  },
  async report() {
    const args = parseReplayArgs(process.argv.slice(4));
    const id = args.runId;
    if (!id) throw new Error('Usage: argus-cli replay report <runId>');
    const data = await fetchJson(`/api/v2/historical-evaluations/${id}/report`);
    console.log(JSON.stringify(data, null, 2));
  },
  async export() {
    const args = parseReplayArgs(process.argv.slice(4));
    const id = args.runId;
    if (!id) throw new Error('Usage: argus-cli replay export <runId>');
    const res = await fetch(`${BASE}/api/v2/historical-evaluations/${id}/export?format=zip`, {
      headers: process.env.ARGUS_DEV_TOKEN ? { 'x-argus-dev-token': process.env.ARGUS_DEV_TOKEN } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    process.stdout.write(buf);
  },
};

const commands: Record<string, () => Promise<void>> = {
  async status() {
    const data = await fetchJson('/api/v2/system/status');
    console.log(JSON.stringify(data, null, 2));
  },
  async health() {
    const data = await fetchJson('/api/v2/live-readiness');
    console.log(JSON.stringify(data, null, 2));
  },
  async positions() {
    const data = await fetchJson('/api/v2/data/portfolio');
    console.log(JSON.stringify(data, null, 2));
  },
  async trades() {
    const data = await fetchJson('/api/v2/data/trades');
    console.log(JSON.stringify(data, null, 2));
  },
  async risk() {
    const data = await fetchJson('/api/v1/risk');
    console.log(JSON.stringify(data, null, 2));
  },
  async agents() {
    const data = await fetchJson('/api/v1/system/pipeline-agents');
    console.log(JSON.stringify(data, null, 2));
  },
  async events() {
    const data = await fetchJson('/api/v2/system/events?limit=50');
    console.log(JSON.stringify(data, null, 2));
  },
  async portfolio() {
    return commands.positions();
  },
  async replay() {
    const sub = process.argv[3];
    if (!sub || sub === 'run' || sub.startsWith('--')) {
      return replayCommands.run();
    }
    const handler = replayCommands[sub];
    if (!handler) {
      throw new Error(`Unknown replay subcommand: ${sub}. Use: run | list | report | export | status`);
    }
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
