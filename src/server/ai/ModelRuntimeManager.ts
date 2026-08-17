/**
 * Central health/registry for optional local model processes. Never fabricates READY.
 * Does not start duplicate processes: probes first, spawns only when ARGUS_START_LOCAL_MODELS=true
 * and the probe failed. Chronos/Kronos Python is additionally gated by ARGUS_START_CHRONOS=true.
 * `npm run dev` (scripts/devWithOpenAlice.ts) sets those flags and starts companions first.
 *
 * OpenAlice Guardian and IBKR Gateway are spawned by the parent `npm run dev` script, not here.
 * This module only probes. IBKR 2FA cannot be completed by Node.
 */
import { spawn, type ChildProcess } from 'child_process';
import https from 'https';
import { eventBus } from '../core/EventBus';
import { openAliceVerificationService } from '../integrations/openalice/OpenAliceVerificationService';
import { preferIpv4Loopback, resolveLocalAiServiceUrl } from './preferIpv4Loopback';
import { runtimeIntervals } from '../config/runtimeIntervals';

export type ModelHealthStatus = 'READY' | 'FAILED' | 'DISABLED' | 'STARTING';

export interface ModelRegistryEntry {
  modelId: string;
  provider: string;
  type: string;
  localOrRemote: 'local' | 'remote' | 'external';
  endpoint: string;
  capabilities: string[];
  health: ModelHealthStatus;
  latencyMs: number | null;
  version: string | null;
  loaded: boolean;
  lastCheckedAt: string | null;
  failureCount: number;
  detail: string | null;
  action: string | null;
}

const OLLAMA_HOST = preferIpv4Loopback(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
const CHRONOS_URL = resolveLocalAiServiceUrl();
const IBKR_URL = process.env.IBKR_GATEWAY_URL || 'https://localhost:5000/v1/api';

const children: ChildProcess[] = [];

async function probe(url: string, timeoutMs = runtimeIntervals.modelRuntimeProbeTimeoutMs): Promise<{ ok: boolean; latencyMs: number; body?: any; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - t0;
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: true, latencyMs, body };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - t0, error: e.message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function trySpawn(command: string, args: string[], label: string): void {
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: true });
    child.unref();
    children.push(child);
    console.log(`[ModelRuntime] Spawned ${label}: ${command} ${args.join(' ')} (pid ${child.pid})`);
  } catch (e: any) {
    console.warn(`[ModelRuntime] Failed to spawn ${label}: ${e.message}`);
  }
}

function trySpawnChronos(): void {
  const port = process.env.LOCAL_AI_SERVICE_PORT || '8008';
  const script = require('path').join(process.cwd(), 'scripts', 'local_ai_service.py');
  const py = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const child = spawn(py, [script], {
      stdio: 'ignore',
      detached: true,
      shell: true,
      env: { ...process.env, LOCAL_AI_SERVICE_PORT: String(port) },
    });
    child.unref();
    children.push(child);
    console.log(`[ModelRuntime] Spawned Chronos/Kronos: ${py} ${script} (pid ${child.pid}, port ${port})`);
  } catch (e: any) {
    console.warn(`[ModelRuntime] Failed to spawn Chronos via python; falling back to npm run ai:serve: ${e.message}`);
    trySpawn('npm', ['run', 'ai:serve'], 'Chronos/Kronos local_ai_service');
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/** IBKR Client Portal Gateway uses a self-signed cert on localhost. Node fetch refuses it (`fetch failed`). */
function probeIbkrAuthStatus(baseUrl: string, timeoutMs: number): Promise<{
  reachable: boolean;
  latencyMs: number;
  authenticated?: boolean;
  connected?: boolean;
  error?: string;
}> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let url: URL;
    try {
      url = new URL(`${baseUrl.replace(/\/$/, '')}/iserver/auth/status`);
    } catch (e: any) {
      resolve({ reachable: false, latencyMs: 0, error: e.message });
      return;
    }
    const req = https.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      rejectUnauthorized: !isLocalHostname(url.hostname),
      timeout: timeoutMs,
      headers: { 'User-Agent': 'ArgusTradingPlatform/1.0' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const latencyMs = Date.now() - t0;
        if (res.statusCode && res.statusCode >= 400) {
          resolve({ reachable: false, latencyMs, error: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          const body = JSON.parse(data || '{}');
          resolve({
            reachable: true,
            latencyMs,
            authenticated: !!body.authenticated,
            connected: body.connected !== false,
          });
        } catch {
          resolve({ reachable: true, latencyMs, authenticated: false });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, latencyMs: Date.now() - t0, error: 'timeout' });
    });
    req.on('error', (e) => {
      resolve({ reachable: false, latencyMs: Date.now() - t0, error: e.message });
    });
    req.end();
  });
}

export class ModelRuntimeManager {
  private static instance: ModelRuntimeManager;
  private registry: ModelRegistryEntry[] = [];
  private started = false;

  static getInstance(): ModelRuntimeManager {
    if (!ModelRuntimeManager.instance) ModelRuntimeManager.instance = new ModelRuntimeManager();
    return ModelRuntimeManager.instance;
  }

  getRegistry(): ModelRegistryEntry[] {
    return this.registry;
  }

  async startAndProbe(): Promise<ModelRegistryEntry[]> {
    if (this.started) {
      return this.refresh();
    }
    this.started = true;
    const allowStart = process.env.ARGUS_START_LOCAL_MODELS === 'true';
    const allowChronos = process.env.ARGUS_START_CHRONOS === 'true';

    const ollama = await probe(`${OLLAMA_HOST}/api/tags`);
    if (!ollama.ok && allowStart) {
      eventBus.emit('MODEL_STARTED', { modelId: 'ollama', endpoint: OLLAMA_HOST });
      trySpawn('ollama', ['serve'], 'Ollama');
      await sleep(1500);
    }

    let chronos = await probe(`${CHRONOS_URL}/health`);
    if (!chronos.ok && allowStart && allowChronos) {
      eventBus.emit('MODEL_STARTED', { modelId: 'chronos', endpoint: CHRONOS_URL });
      trySpawnChronos();
      for (let i = 0; i < 45 && !chronos.ok; i++) {
        await sleep(2000);
        chronos = await probe(`${CHRONOS_URL}/health`, 3000);
      }
    }

    return this.refresh();
  }

  /** Diagnostics retry: re-probe, and spawn Chronos again if npm run dev allowed it. */
  async retryUnhealthy(): Promise<ModelRegistryEntry[]> {
    const allowStart = process.env.ARGUS_START_LOCAL_MODELS === 'true';
    const allowChronos = process.env.ARGUS_START_CHRONOS === 'true';
    let chronos = await probe(`${CHRONOS_URL}/health`, 3000);
    if (!chronos.ok && allowStart && allowChronos) {
      eventBus.emit('MODEL_STARTED', { modelId: 'chronos', endpoint: CHRONOS_URL });
      trySpawnChronos();
      for (let i = 0; i < 20 && !chronos.ok; i++) {
        await sleep(2000);
        chronos = await probe(`${CHRONOS_URL}/health`, 3000);
      }
    }
    return this.refresh();
  }

  async refresh(): Promise<ModelRegistryEntry[]> {
    const [ollama, chronos, openalice, ibkr] = await Promise.all([
      this.probeOllama(),
      this.probeChronos(),
      this.probeOpenAlice(),
      this.probeIbkr(),
    ]);
    this.registry = [ollama, chronos, openalice, ibkr];
    for (const m of this.registry) {
      eventBus.emit('MODEL_HEALTH', {
        modelId: m.modelId, health: m.health, detail: m.detail, latencyMs: m.latencyMs, loaded: m.loaded,
      });
    }
    return this.registry;
  }

  private async probeOllama(): Promise<ModelRegistryEntry> {
    const p = await probe(`${OLLAMA_HOST}/api/tags`);
    const models = p.body?.models?.map((m: any) => m.name) || [];
    return {
      modelId: 'ollama',
      provider: 'Ollama',
      type: 'llm',
      localOrRemote: 'local',
      endpoint: OLLAMA_HOST,
      capabilities: ['GENERAL_REASONING', 'NEWS_REASONING'],
      health: p.ok ? 'READY' : 'FAILED',
      latencyMs: p.latencyMs,
      version: models[0] || null,
      loaded: p.ok,
      lastCheckedAt: new Date().toISOString(),
      failureCount: p.ok ? 0 : 1,
      detail: p.ok ? `tags ok (${models.length} model(s))` : (p.error || 'unreachable'),
      action: p.ok ? null : "Install Ollama and run 'ollama serve'. npm run dev starts it when ollama is on PATH.",
    };
  }

  private async probeChronos(): Promise<ModelRegistryEntry> {
    const p = await probe(`${CHRONOS_URL}/health`);
    return {
      modelId: 'chronos-kronos',
      provider: 'Chronos (local_ai_service.py) / KronosEngine',
      type: 'forecast',
      localOrRemote: 'local',
      endpoint: CHRONOS_URL,
      capabilities: ['PRICE_FORECAST', 'TIME_SERIES_FORECAST'],
      health: p.ok ? 'READY' : 'FAILED',
      latencyMs: p.latencyMs,
      version: p.body?.model || null,
      loaded: p.ok,
      lastCheckedAt: new Date().toISOString(),
      failureCount: p.ok ? 0 : 1,
      detail: p.ok ? `health ok (${p.body?.model || 'chronos'})` : (p.error || 'unreachable'),
      action: p.ok
        ? null
        : "npm run dev starts Chronos. If this stays FAILED: Python 3.10+, npm run setup:ai, and confirm local_ai_service.py is still running. Skip with ARGUS_SKIP_CHRONOS=true.",
    };
  }

  private async probeOpenAlice(): Promise<ModelRegistryEntry> {
    const h = await openAliceVerificationService.health();
    const enabled = openAliceVerificationService.enabled;
    const wrongMcp = /wrong MCP|trading\/broker|missing expected tools/i.test(h.detail || '');
    const launchError = process.env.OPENALICE_LAUNCH_ERROR?.trim();
    const detail = !h.reachable && launchError ? `${h.detail} — ${launchError}` : h.detail;
    return {
      modelId: 'openalice',
      provider: 'OpenAlice MCP',
      type: 'independent-verification',
      localOrRemote: 'external',
      endpoint: openAliceVerificationService.mcpUrl || process.env.OPENALICE_MCP_URL || '(unset)',
      capabilities: ['INDEPENDENT_VERIFICATION'],
      health: !enabled ? 'DISABLED' : (h.reachable ? 'READY' : 'FAILED'),
      latencyMs: null,
      version: null,
      loaded: !!h.reachable,
      lastCheckedAt: h.checkedAt,
      failureCount: h.reachable ? 0 : (enabled ? 1 : 0),
      detail,
      action: enabled && !h.reachable
        ? (wrongMcp
          ? 'Point OPENALICE_MCP_URL at OpenAlice Guardian (http://127.0.0.1:47332/mcp), not a trading MCP. npm run dev starts Guardian from OPENALICE_PATH / OPENALICE_REPO_PATH.'
          : (launchError || 'Start OpenAlice Guardian (npm run dev) and set OPENALICE_ENABLED=true plus OPENALICE_MCP_URL=http://127.0.0.1:47332/mcp. Skip with ARGUS_SKIP_OPENALICE=true or ENABLE_OPENALICE=false.'))
        : null,
    };
  }

  private async probeIbkr(): Promise<ModelRegistryEntry> {
    const configured = !!process.env.IBKR_GATEWAY_URL || process.env.ARGUS_PROBE_IBKR === 'true';
    if (!configured) {
      return {
        modelId: 'ibkr-gateway',
        provider: 'Interactive Brokers Client Portal',
        type: 'broker-proxy',
        localOrRemote: 'local',
        endpoint: IBKR_URL,
        capabilities: [],
        health: 'DISABLED',
        latencyMs: null,
        version: null,
        loaded: false,
        lastCheckedAt: new Date().toISOString(),
        failureCount: 0,
        detail: 'Not probed unless IBKR_GATEWAY_URL or ARGUS_PROBE_IBKR=true.',
        action: null,
      };
    }
    const p = await probeIbkrAuthStatus(IBKR_URL, 4000);
    if (!p.reachable) {
      return {
        modelId: 'ibkr-gateway',
        provider: 'Interactive Brokers Client Portal',
        type: 'broker-proxy',
        localOrRemote: 'local',
        endpoint: IBKR_URL,
        capabilities: [],
        health: 'FAILED',
        latencyMs: p.latencyMs,
        version: null,
        loaded: false,
        lastCheckedAt: new Date().toISOString(),
        failureCount: 1,
        detail: p.error || 'unreachable',
        action: 'Set IBKR_GATEWAY_PATH to the Client Portal Gateway folder (contains bin/run.bat). npm run dev starts it and opens the login page. 2FA is manual (~24h).',
      };
    }
    const authenticated = !!p.authenticated;
    return {
      modelId: 'ibkr-gateway',
      provider: 'Interactive Brokers Client Portal',
      type: 'broker-proxy',
      localOrRemote: 'local',
      endpoint: IBKR_URL,
      capabilities: [],
      health: authenticated ? 'READY' : 'STARTING',
      latencyMs: p.latencyMs,
      version: null,
      loaded: authenticated,
      lastCheckedAt: new Date().toISOString(),
      failureCount: 0,
      detail: authenticated
        ? 'Gateway reachable and brokerage session authenticated'
        : 'Gateway reachable. Complete browser 2FA at the Gateway URL (opened by npm run dev). This cannot be automated.',
      action: authenticated ? null : `Open ${IBKR_URL.replace(/\/v1\/api\/?$/, '')} and complete IBKR login + 2FA`,
    };
  }
}

export const modelRuntimeManager = ModelRuntimeManager.getInstance();
