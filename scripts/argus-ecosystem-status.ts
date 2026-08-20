/**
 * Prints ecosystem service health in the same shape as ModelRuntimeManager / OrchestrationStatus.
 * Used by argus.sh after start|restart|stop|nuke and for `./argus.sh status`.
 * Probes real endpoints only — never fabricates READY.
 */
import 'dotenv/config';
import https from 'https';
import net from 'net';
import {
  GUARDIAN_MCP_URL,
  mcpEndpointIsOpenAlice,
  openAliceSkipReason,
  shouldSkipOpenAlice,
} from './openAliceDevSupport';

type Health = 'READY' | 'FAILED' | 'DISABLED' | 'STARTING' | 'STOPPED';

interface ServiceStatus {
  id: string;
  detail: string;
  health: Health;
  action: string | null;
}

const mode = process.argv.includes('--mode') && process.argv[process.argv.indexOf('--mode') + 1] === 'stopped'
  ? 'stopped'
  : 'live';
const afterStart = process.argv.includes('--after-start');

function preferIpv4Loopback(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/$/, '');
  }
}

function resolveChronosUrl(): string {
  const port = process.env.LOCAL_AI_SERVICE_PORT || '8008';
  const raw = process.env.LOCAL_AI_SERVICE_URL || `http://127.0.0.1:${port}`;
  return preferIpv4Loopback(raw.replace(/:8000(?=\/|$)/, ':8008'));
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host, timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

async function probe(url: string, timeoutMs = 3000): Promise<{ ok: boolean; body?: any; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: true, body };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function probeWithRetry(
  url: string,
  opts: { timeoutMs: number; attempts: number; delayMs: number },
): Promise<{ ok: boolean; body?: any; error?: string }> {
  let last = { ok: false, error: 'unreachable' as string | undefined };
  for (let i = 0; i < opts.attempts; i++) {
    last = await probe(url, opts.timeoutMs);
    if (last.ok) return last;
    if (i + 1 < opts.attempts) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function probeIbkrAuthStatus(baseUrl: string, timeoutMs: number): Promise<{
  reachable: boolean;
  authenticated?: boolean;
  error?: string;
}> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(`${baseUrl.replace(/\/$/, '')}/iserver/auth/status`);
    } catch (e: any) {
      resolve({ reachable: false, error: e.message });
      return;
    }
    const req = https.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      rejectUnauthorized: url.hostname !== '127.0.0.1' && url.hostname !== 'localhost',
      timeout: timeoutMs,
      headers: { 'User-Agent': 'ArgusTradingPlatform/1.0' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        // 401 = Gateway listening, brokerage session not authenticated yet (manual 2FA).
        if (res.statusCode === 401) {
          resolve({ reachable: true, authenticated: false });
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          resolve({ reachable: false, error: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const body = JSON.parse(data || '{}');
          resolve({ reachable: true, authenticated: !!body.authenticated });
        } catch {
          resolve({ reachable: true, authenticated: false });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ reachable: false, error: e.message }));
    req.end();
  });
}

async function maybeStopped(port: number, id: string, label: string): Promise<ServiceStatus | null> {
  if (mode !== 'stopped') return null;
  const open = await isPortOpen(port);
  if (!open) {
    return {
      id,
      detail: `${label} not listening (expected after stop/nuke)`,
      health: 'STOPPED',
      action: null,
    };
  }
  return null;
}

async function probeOllama(): Promise<ServiceStatus> {
  if (process.env.ARGUS_SKIP_OLLAMA === 'true') {
    return {
      id: 'ollama',
      detail: 'Skipped (ARGUS_SKIP_OLLAMA=true)',
      health: 'DISABLED',
      action: null,
    };
  }
  const host = preferIpv4Loopback(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
  let port = 11434;
  try {
    const u = new URL(host);
    if (u.port) port = Number(u.port);
  } catch { /* keep default */ }

  const stopped = await maybeStopped(port, 'ollama', 'Ollama');
  if (stopped) return stopped;

  const p = await probe(`${host}/api/tags`);
  const models = p.body?.models?.map((m: any) => m.name) || [];
  return {
    id: 'ollama',
    health: p.ok ? 'READY' : 'FAILED',
    detail: p.ok ? `tags ok (${models.length} model(s))` : (p.error || 'unreachable'),
    action: p.ok ? null : "Install Ollama and run 'ollama serve'. npm run dev / argus.sh start tries to start it when ollama is on PATH.",
  };
}

async function probeChronos(): Promise<ServiceStatus> {
  if (process.env.ARGUS_SKIP_CHRONOS === 'true') {
    return {
      id: 'chronos-kronos',
      detail: 'Skipped (ARGUS_SKIP_CHRONOS=true)',
      health: 'DISABLED',
      action: null,
    };
  }
  const url = resolveChronosUrl();
  let port = 8008;
  try { port = Number(new URL(url).port) || 8008; } catch { /* keep */ }

  const stopped = await maybeStopped(port, 'chronos-kronos', 'Chronos/Kronos');
  if (stopped) return stopped;

  const p = await probe(`${url}/health`);
  return {
    id: 'chronos-kronos',
    health: p.ok ? 'READY' : 'FAILED',
    detail: p.ok ? `health ok (${p.body?.model || 'chronos'})` : (p.error || 'unreachable'),
    action: p.ok
      ? null
      : 'npm run dev starts Chronos. If FAILED: Python 3.10+, npm run setup:ai, confirm local_ai_service.py is running. Skip with ARGUS_SKIP_CHRONOS=true.',
  };
}

async function probeOpenAlice(): Promise<ServiceStatus> {
  if (shouldSkipOpenAlice()) {
    return {
      id: 'openalice',
      detail: openAliceSkipReason() || 'OpenAlice Guardian disabled',
      health: 'DISABLED',
      action: null,
    };
  }
  const mcpUrl = preferIpv4Loopback(process.env.OPENALICE_MCP_URL || GUARDIAN_MCP_URL);
  let port = 47332;
  try { port = Number(new URL(mcpUrl).port) || 47332; } catch { /* keep */ }

  const stopped = await maybeStopped(port, 'openalice', 'OpenAlice Guardian MCP');
  if (stopped) return stopped;

  const identity = await mcpEndpointIsOpenAlice(mcpUrl);
  const launchError = process.env.OPENALICE_LAUNCH_ERROR?.trim();
  if (identity.ok) {
    return {
      id: 'openalice',
      health: 'READY',
      detail: identity.reason,
      action: null,
    };
  }
  const detail = launchError ? `${identity.reason} — ${launchError}` : identity.reason;
  return {
    id: 'openalice',
    health: 'FAILED',
    detail: detail.startsWith('Unreachable') || detail.startsWith('Wrong') ? detail : `Unreachable: ${detail}`,
    action: 'Start OpenAlice Guardian (npm run dev / argus.sh start). Set OPENALICE_PATH or OPENALICE_REPO_PATH. Skip with ARGUS_SKIP_OPENALICE=true or ENABLE_OPENALICE=false.',
  };
}

async function probeIbkr(): Promise<ServiceStatus> {
  if (process.env.ARGUS_SKIP_IBKR === 'true') {
    return {
      id: 'ibkr-gateway',
      detail: 'Skipped (ARGUS_SKIP_IBKR=true)',
      health: 'DISABLED',
      action: null,
    };
  }
  const baseUrl = process.env.IBKR_GATEWAY_URL || 'https://localhost:5000/v1/api';
  let port = 5000;
  try { port = Number(new URL(baseUrl).port) || 5000; } catch { /* keep */ }

  const stopped = await maybeStopped(port, 'ibkr-gateway', 'IBKR Client Portal Gateway');
  if (stopped) return stopped;

  const configured = !!process.env.IBKR_GATEWAY_URL?.trim() || process.env.ARGUS_PROBE_IBKR === 'true';
  if (!configured && !(await isPortOpen(port))) {
    return {
      id: 'ibkr-gateway',
      detail: 'Not probed (port free; set IBKR_GATEWAY_PATH or ARGUS_PROBE_IBKR=true to spawn)',
      health: 'DISABLED',
      action: null,
    };
  }

  const p = await probeIbkrAuthStatus(baseUrl, 4000);
  if (!p.reachable) {
    return {
      id: 'ibkr-gateway',
      health: 'FAILED',
      detail: p.error || 'unreachable',
      action: 'Set IBKR_GATEWAY_PATH to the Client Portal Gateway folder (contains bin/run.bat). npm run dev starts it and opens the login page. 2FA is manual (~24h).',
    };
  }
  if (p.authenticated) {
    return {
      id: 'ibkr-gateway',
      health: 'READY',
      detail: 'Gateway reachable and brokerage session authenticated',
      action: null,
    };
  }
  return {
    id: 'ibkr-gateway',
    health: 'STARTING',
    detail: 'Gateway reachable (HTTP 401 — login pending). Complete browser 2FA at the Gateway URL.',
    action: `Open ${baseUrl.replace(/\/v1\/api\/?$/, '')} and complete IBKR login + 2FA`,
  };
}

async function probeArgus(): Promise<ServiceStatus> {
  const stopped = await maybeStopped(3000, 'argus', 'Argus Node/Vite server');
  if (stopped) return stopped;

  const portOpen = await isPortOpen(3000);
  const p = await probeWithRetry('http://127.0.0.1:3000/health', {
    timeoutMs: afterStart ? 12_000 : 6_000,
    attempts: afterStart ? 5 : 2,
    delayMs: 2_000,
  });
  if (p.ok) {
    return {
      id: 'argus',
      health: 'READY',
      detail: 'GET /health ok (port 3000)',
      action: null,
    };
  }
  if (portOpen && afterStart) {
    return {
      id: 'argus',
      health: 'STARTING',
      detail: `Port 3000 listening; GET /health slow or busy (${p.error || 'timeout'}). Boot may still be finishing agents.`,
      action: 'Wait a few seconds and run ./argus.sh status again, or check logs/argus-dev.log.',
    };
  }
  if (portOpen) {
    return {
      id: 'argus',
      health: 'STARTING',
      detail: `Port 3000 listening; GET /health not ready (${p.error || 'timeout'})`,
      action: 'Check logs/argus-dev.log — server may still be booting.',
    };
  }
  return {
    id: 'argus',
    health: 'FAILED',
    detail: p.error || 'unreachable',
    action: 'Check logs/argus-dev.log. Port 3000 may still be booting or npm run dev failed.',
  };
}

function printService(s: ServiceStatus): void {
  console.log(s.id);
  console.log(s.detail);
  if (s.action) console.log(`Action: ${s.action}`);
  console.log(s.health);
  console.log('');
}

async function main(): Promise<void> {
  // Probe companions first; Argus last so a busy boot event loop does not starve /health.
  const companions = await Promise.all([
    probeOllama(),
    probeChronos(),
    probeOpenAlice(),
    probeIbkr(),
  ]);
  if (afterStart) await sleep(1_000);
  const argus = await probeArgus();
  for (const s of [...companions, argus]) printService(s);
}

main().catch((e) => {
  console.error(`argus-ecosystem-status: ${e?.message || e}`);
  process.exit(1);
});
