/**
 * Central health/registry for optional local model processes. Never fabricates READY.
 * Does not start duplicate processes: probes first, spawns only when ARGUS_START_LOCAL_MODELS=true
 * and the probe failed. Chronos/Kronos Python is additionally gated by ARGUS_START_CHRONOS=true.
 * `npm run dev` (scripts/devWithOpenAlice.ts) sets those flags and starts companions first.
 *
 * OpenAlice Guardian is spawned by the parent `npm run dev` script, not here.
 * This module only probes. IBKR health adapts to the active broker (socket :4002 vs
 * Client Portal :5000 vs STANDBY when Alpaca/Internal Paper is active).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import path from 'node:path';
import { eventBus } from '../core/EventBus';
import { openAliceVerificationService } from '../integrations/openalice/OpenAliceVerificationService';
import { preferIpv4Loopback, resolveLocalAiServiceUrl } from './preferIpv4Loopback';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { aiModels } from '../config/aiModels';
import { networkEndpoints } from '../config/networkEndpoints';
import {
  probeIbkrEcosystemHealth,
  resolveActiveBrokerIdForHealth,
  resolveIbkrSessionAccountId,
} from '../services/ibkrEcosystemHealth';

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

const OLLAMA_HOST = preferIpv4Loopback(process.env.OLLAMA_HOST || networkEndpoints.aiLocal.ollamaDefault);
const CHRONOS_URL = resolveLocalAiServiceUrl();

/**
 * A2 (2026-10-08): spawned model-runtime children are tracked in a BOUNDED set, reaped on
 * 'exit'/'error', and killed on stop()/shutdown.
 *
 * Defect this replaces (the old `const children: ChildProcess[] = []` was push-only): every
 * spawned child was appended and never removed - no 'exit' listener, no cap, no stop() -
 * so (a) the array grew without bound across retryUnhealthy() calls (each ChildProcess object
 * plus its listeners kept reachable forever), (b) retryUnhealthy() could spawn a second live
 * Chronos while the first was still bound to the same port, and (c) children were spawned
 * detached+unref'd with no shutdown hook, surviving engine shutdown as orphans.
 */
interface TrackedModelChild {
  child: ChildProcess;
  /** 'Ollama' | 'Chronos/Kronos' | 'Chronos/Kronos local_ai_service' - lets retryUnhealthy()
   *  kill only the live child it is about to replace, never an unrelated one. */
  label: string;
  spawnedAtMs: number;
}
const trackedChildren = new Set<TrackedModelChild>();

/** Remove one entry and drop its listeners so neither the ChildProcess nor the entry is kept
 *  reachable after the child is gone. Idempotent: safe to call from both the 'exit'/'error'
 *  listener and an explicit kill path. */
function reapChild(entry: TrackedModelChild): void {
  trackedChildren.delete(entry);
  try { entry.child.removeAllListeners('exit'); } catch { /* already gone */ }
  try { entry.child.removeAllListeners('error'); } catch { /* already gone */ }
}

/** Drop entries whose process already ended but whose 'exit' event has not been observed yet,
 *  so size checks and shutdown sweeps always see the live set. */
function reapDeadChildren(): void {
  for (const entry of [...trackedChildren]) {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) reapChild(entry);
  }
}

/**
 * Track a freshly spawned child. Returns false when the concurrency cap refused it - the
 * caller must treat the child as NOT adopted (spawnTracked SIGKILLs it so it cannot leak).
 * Reaping on 'exit' AND 'error': a spawn failure (e.g. binary not on PATH) surfaces as an
 * async 'error' event, and without a listener Node would throw it unhandled while the entry
 * stayed tracked forever.
 */
function trackChild(child: ChildProcess, label: string): boolean {
  reapDeadChildren();
  const cap = runtimeIntervals.modelRuntimeMaxChildren;
  if (trackedChildren.size >= cap) {
    console.warn(
      `[ModelRuntime] NOT tracking ${label} (pid ${child.pid}): ${trackedChildren.size} children ` +
      `already tracked (cap modelRuntimeMaxChildren=${cap}) - refusing to spawn what cannot be ` +
      `tracked. Killing the excess child instead of leaking it.`,
    );
    try { child.kill('SIGKILL'); } catch { /* best-effort */ }
    return false;
  }
  const entry: TrackedModelChild = { child, label, spawnedAtMs: Date.now() };
  const onDone = () => reapChild(entry);
  child.once('exit', onDone);
  child.once('error', onDone);
  trackedChildren.add(entry);
  return true;
}

/** Kill every live tracked child carrying the given label (dead ones are reaped first).
 *  Used by retryUnhealthy() before re-spawning Chronos: a retry must never stack a second
 *  live process on the same port while the first is still alive. */
function killTrackedChildrenByLabel(label: string): void {
  reapDeadChildren();
  for (const entry of [...trackedChildren]) {
    if (entry.label !== label) continue;
    try {
      if (entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.child.kill('SIGTERM');
      }
    } catch (e: any) {
      console.warn(`[ModelRuntime] Failed to kill ${label} (pid ${entry.child.pid}): ${e?.message}`);
    }
    reapChild(entry);
  }
}

/**
 * Spawn through the single tracked path. Returns the child, or null when the spawn failed
 * synchronously or the tracking cap refused it (the over-cap child is SIGKILLed inside
 * trackChild, never leaked). extraOpts may override defaults (tests pass { shell: false }).
 */
function spawnTracked(command: string, args: string[], label: string, extraOpts?: SpawnOptions): ChildProcess | null {
  let child: ChildProcess;
  try {
    child = spawn(command, args, { stdio: 'ignore', detached: true, shell: true, ...extraOpts });
  } catch (e: any) {
    console.warn(`[ModelRuntime] Failed to spawn ${label}: ${e.message}`);
    return null;
  }
  child.unref();
  if (!trackChild(child, label)) return null;
  console.log(`[ModelRuntime] Spawned ${label}: ${command} ${args.join(' ')} (pid ${child.pid})`);
  return child;
}

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

/** Real, cheap completion — the actual capability trading agents need, not just process
 *  reachability. `stream: false` so the response is a single small JSON body. */
async function probeOllamaCompletion(model: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'ping', stream: false }),
      // Real bug found live (2026-09-07): this used runtimeIntervals.ollamaCompletionProbeTimeoutMs
      // (8s) - the same cap AIRouter.ts's own comment documents as meant for REMOTE (paid)
      // providers, whose 2026-09-02 fix explicitly split off a separate, longer
      // aiModels.ollamaHardTimeoutMs (25s) for local Ollama specifically, after a live cold-load
      // test measured ~13s round-trip. This probe was never updated to match, so it kept aborting
      // real, successful-but-slower Ollama completions (reproduced live: fingpt:latest genuinely
      // took ~14.6s here, mostly reported load time) and showing FAILED in the Model Runtime panel
      // even while the SAME model was routing real agent calls successfully elsewhere. Reusing the
      // established local-Ollama timeout instead of inventing a third value.
      signal: AbortSignal.timeout(aiModels.ollamaHardTimeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body: any = await res.json().catch(() => null);
    const text = typeof body?.response === 'string' ? body.response : '';
    return text.length > 0 ? { ok: true } : { ok: false, error: 'empty response' };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function trySpawn(command: string, args: string[], label: string): void {
  spawnTracked(command, args, label);
}

function trySpawnChronos(): void {
  const port = process.env.LOCAL_AI_SERVICE_PORT || '8008';
  // Real bug found and fixed (Phase 14 historical-replay mission, 2026-08-31): require('path')
  // throws "require is not defined" in this server's ESM runtime, unguarded by any try/catch -
  // every trySpawnChronos() call would have failed here before ever reaching the spawn attempt
  // below. path is a normal ESM import like every other module dependency in this file.
  const script = path.join(process.cwd(), 'scripts', 'local_ai_service.py');
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawnTracked(py, [script], 'Chronos/Kronos', {
    env: { ...process.env, LOCAL_AI_SERVICE_PORT: String(port) },
  });
  if (!child) {
    console.warn('[ModelRuntime] Failed to spawn Chronos via python; falling back to npm run ai:serve');
    trySpawn('npm', ['run', 'ai:serve'], 'Chronos/Kronos local_ai_service');
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

  /**
   * A2 (2026-10-08): kill every tracked model-runtime child and drop all references.
   * Called by the graceful-shutdown drain (src/server/core/gracefulShutdown.ts) so spawned
   * Ollama/Chronos companions never outlive the engine as detached orphans - previously
   * nothing killed them and the tracking array grew forever. Idempotent: safe to call
   * twice, and safe when nothing was ever spawned.
   */
  stop(): void {
    reapDeadChildren();
    for (const entry of [...trackedChildren]) {
      try {
        if (entry.child.exitCode === null && entry.child.signalCode === null) {
          entry.child.kill('SIGTERM');
        }
      } catch (e: any) {
        console.warn(`[ModelRuntime] Failed to kill ${entry.label} (pid ${entry.child.pid}): ${e?.message}`);
      }
      reapChild(entry);
    }
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
      // A2 (2026-10-08): never stack a second live Chronos on the same port - a previous
      // retry may have left one alive (or still starting). Kill live same-label children
      // first (dead ones are reaped inside), then spawn exactly one.
      killTrackedChildrenByLabel('Chronos/Kronos');
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

    // Real gap found live (2026-08-26 forensic audit): /api/tags reachability was the entire
    // health check, so Ollama could report READY while every real completion call failed (e.g.
    // model load/OOM failure, wrong model name) - a "false health" pattern. If tags succeeded and
    // at least one model is listed, also attempt one cheap real completion against that model
    // before declaring READY.
    let completionOk = true;
    let completionDetail = '';
    if (p.ok && models.length > 0) {
      const completion = await probeOllamaCompletion(models[0]);
      completionOk = completion.ok;
      completionDetail = completion.ok ? '' : ` — but completion probe failed: ${completion.error || 'no output'}`;
    }

    const healthy = p.ok && completionOk;
    return {
      modelId: 'ollama',
      provider: 'Ollama',
      type: 'llm',
      localOrRemote: 'local',
      endpoint: OLLAMA_HOST,
      capabilities: ['GENERAL_REASONING', 'NEWS_REASONING'],
      health: healthy ? 'READY' : 'FAILED',
      latencyMs: p.latencyMs,
      version: models[0] || null,
      loaded: healthy,
      lastCheckedAt: new Date().toISOString(),
      failureCount: healthy ? 0 : 1,
      detail: p.ok ? `tags ok (${models.length} model(s))${completionDetail}` : (p.error || 'unreachable'),
      action: healthy ? null : "Install Ollama and run 'ollama serve'. npm run dev starts it when ollama is on PATH.",
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
    const activeBrokerId = await resolveActiveBrokerIdForHealth();
    const sessionAccountId = await resolveIbkrSessionAccountId();
    const r = await probeIbkrEcosystemHealth({
      activeBrokerIdOrName: activeBrokerId,
      sessionAccountId,
    });
    const health: ModelHealthStatus =
      r.health === 'STOPPED' ? 'DISABLED' : (r.health as ModelHealthStatus);
    return {
      modelId: 'ibkr-gateway',
      provider: r.provider,
      type: 'broker-proxy',
      localOrRemote: 'local',
      endpoint: r.endpoint,
      capabilities: [],
      health,
      latencyMs: r.latencyMs,
      version: null,
      loaded: r.loaded,
      lastCheckedAt: new Date().toISOString(),
      failureCount: health === 'FAILED' ? 1 : 0,
      detail: r.detail,
      action: r.action,
    };
  }
}

export const modelRuntimeManager = ModelRuntimeManager.getInstance();

/** Test-only: spawn through the real tracked path (never real model binaries - the test passes
 *  its own command, e.g. process.execPath). Returns the child, or null when the spawn failed
 *  or the concurrency cap refused it. */
export function __spawnModelChildForTests(
  command: string,
  args: string[],
  label: string,
  extraOpts?: SpawnOptions,
): ChildProcess | null {
  return spawnTracked(command, args, label, extraOpts);
}

/** Test-only: number of currently-tracked children (reaps dead ones first, like production). */
export function __trackedModelChildCountForTests(): number {
  reapDeadChildren();
  return trackedChildren.size;
}

/** Test-only: the same label-scoped kill retryUnhealthy() uses before re-spawning. */
export function __killTrackedChildrenByLabelForTests(label: string): void {
  killTrackedChildrenByLabel(label);
}
