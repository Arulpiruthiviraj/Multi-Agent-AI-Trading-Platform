/**
 * Central health/registry for optional local model processes. Never fabricates READY.
 * Does not start duplicate processes: probes first, spawns only when ARGUS_START_LOCAL_MODELS=true
 * and the probe failed. Chronos/Kronos Python is additionally gated by ARGUS_START_CHRONOS=true
 * because loading the model on every `npm run dev` would stall the machine.
 *
 * OpenAlice and IBKR Gateway are never spawned here (external / 2FA).
 */
import { spawn, type ChildProcess } from 'child_process';
import { eventBus } from '../core/EventBus';
import { openAliceVerificationService } from '../integrations/openalice/OpenAliceVerificationService';

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

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const CHRONOS_URL = process.env.LOCAL_AI_SERVICE_URL || 'http://localhost:8008';
const IBKR_URL = process.env.IBKR_GATEWAY_URL || 'https://localhost:5000/v1/api';

const children: ChildProcess[] = [];

async function probe(url: string, timeoutMs = 2000): Promise<{ ok: boolean; latencyMs: number; body?: any; error?: string }> {
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
      await new Promise(r => setTimeout(r, 1500));
    }

    const chronos = await probe(`${CHRONOS_URL}/health`);
    if (!chronos.ok && allowStart && allowChronos) {
      eventBus.emit('MODEL_STARTED', { modelId: 'chronos', endpoint: CHRONOS_URL });
      trySpawn('npm', ['run', 'ai:serve'], 'Chronos/Kronos local_ai_service');
      await new Promise(r => setTimeout(r, 2000));
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
      action: p.ok ? null : "Install Ollama and run 'ollama serve', or set ARGUS_START_LOCAL_MODELS=true",
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
      action: p.ok ? null : "Run 'npm run ai:serve' (or ARGUS_START_CHRONOS=true with ARGUS_START_LOCAL_MODELS=true)",
    };
  }

  private async probeOpenAlice(): Promise<ModelRegistryEntry> {
    const h = await openAliceVerificationService.health();
    const enabled = openAliceVerificationService.enabled;
    return {
      modelId: 'openalice',
      provider: 'OpenAlice MCP',
      type: 'independent-verification',
      localOrRemote: 'external',
      endpoint: process.env.OPENALICE_MCP_URL || '(unset)',
      capabilities: ['INDEPENDENT_VERIFICATION'],
      health: !enabled ? 'DISABLED' : (h.reachable ? 'READY' : 'FAILED'),
      latencyMs: null,
      version: null,
      loaded: !!h.reachable,
      lastCheckedAt: h.checkedAt,
      failureCount: h.reachable ? 0 : (enabled ? 1 : 0),
      detail: h.detail,
      action: enabled && !h.reachable ? 'Start OpenAlice and set OPENALICE_MCP_URL' : null,
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
        detail: 'Not probed unless IBKR_GATEWAY_URL or ARGUS_PROBE_IBKR=true (avoids noisy TLS failures).',
        action: null,
      };
    }
    const p = await probe(`${IBKR_URL.replace(/\/$/, '')}/iserver/auth/status`, 2000);
    return {
      modelId: 'ibkr-gateway',
      provider: 'Interactive Brokers Client Portal',
      type: 'broker-proxy',
      localOrRemote: 'local',
      endpoint: IBKR_URL,
      capabilities: [],
      health: p.ok ? 'READY' : 'FAILED',
      latencyMs: p.latencyMs,
      version: null,
      loaded: p.ok,
      lastCheckedAt: new Date().toISOString(),
      failureCount: p.ok ? 0 : 1,
      detail: p.ok ? 'gateway reachable' : (p.error || 'unreachable'),
      action: p.ok ? null : 'Start IBKR Client Portal Gateway locally and complete browser 2FA',
    };
  }
}

export const modelRuntimeManager = ModelRuntimeManager.getInstance();
