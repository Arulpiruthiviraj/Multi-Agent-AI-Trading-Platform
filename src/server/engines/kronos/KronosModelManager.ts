import { eventBus } from '../../core/EventBus';
import { resolveLocalAiServiceUrl } from '../../ai/preferIpv4Loopback';
import { runtimeIntervals } from '../../config/runtimeIntervals';

export type KronosStatus = 'Loading...' | 'Downloading...' | 'Initializing...' | 'Ready' | 'Warning: Kronos unavailable';

const SERVICE_URL = resolveLocalAiServiceUrl();
// Re-checked lazily rather than once at boot - the local inference service (scripts/
// local_ai_service.py) is meant to be started/stopped independently of the Node process, like
// Ollama. A one-shot boot-time check would permanently report unavailable if the service was
// started a moment after this process, even once it's actually up and reachable.
const RECHECK_INTERVAL_MS = runtimeIntervals.kronosRecheckMs;

function formatHardwareLabel(device: string | null | undefined, memory: string | null | undefined): { memoryUsage: string | null; gpuUsage: string | null } {
  const d = (device || '').toLowerCase();
  if (d.includes('cuda') || d.includes('gpu')) {
    return {
      memoryUsage: memory || null,
      gpuUsage: memory || device || 'GPU',
    };
  }
  // CPU / Apple MPS: honest N/A rather than inventing a GPU % or leaving "--".
  if (d.includes('mps')) {
    return {
      memoryUsage: memory || 'N/A (CPU/MPS)',
      gpuUsage: 'N/A (CPU/MPS)',
    };
  }
  if (d.includes('cpu') || !d) {
    return {
      memoryUsage: memory || (d ? 'N/A (CPU/MPS)' : null),
      gpuUsage: d ? 'N/A (CPU/MPS)' : null,
    };
  }
  return { memoryUsage: memory || null, gpuUsage: null };
}

export class KronosModelManager {
  private status: KronosStatus = 'Loading...';
  private modelVersion: string = 'unknown';
  private isAvailable: boolean = false;
  private memoryUsage: string | null = null;
  private gpuUsage: string | null = null;
  private inferenceTime: number = 0;
  private device: string | null = null;
  private lastCheckedAt: number = 0;
  private refreshInFlight: Promise<void> | null = null;

  constructor() {}

  public async initialize(): Promise<void> {
    await this.refreshAvailability();
  }

  private async refreshAvailability(): Promise<void> {
    this.lastCheckedAt = Date.now();
    try {
      const res = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      this.isAvailable = true;
      this.modelVersion = body.model || 'unknown';
      this.device = typeof body.device === 'string' ? body.device : null;
      const hw = formatHardwareLabel(this.device, typeof body.memoryUsage === 'string' ? body.memoryUsage : null);
      this.memoryUsage = hw.memoryUsage;
      this.gpuUsage = hw.gpuUsage;
      if (typeof body.lastInferenceMs === 'number' && Number.isFinite(body.lastInferenceMs) && body.lastInferenceMs > 0) {
        this.inferenceTime = body.lastInferenceMs;
      } else if (typeof body.latencyMs === 'number' && Number.isFinite(body.latencyMs) && body.latencyMs > 0) {
        // Python /health may expose latencyMs as an alias of lastInferenceMs.
        this.inferenceTime = body.latencyMs;
      }
      this.updateStatus('Ready');
      console.log(`[KronosModelManager] Local Chronos inference service reachable at ${SERVICE_URL} (${this.modelVersion}).`);
    } catch (e: any) {
      this.isAvailable = false;
      this.memoryUsage = null;
      this.gpuUsage = null;
      this.updateStatus('Warning: Kronos unavailable');
      console.warn(`[KronosModelManager] Local Chronos inference service not reachable at ${SERVICE_URL} - reporting unavailable. npm run dev starts it (or npm run ai:serve). (${e.message})`);
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshInFlight) return;
    this.refreshInFlight = this.refreshAvailability()
      .catch(() => {})
      .finally(() => { this.refreshInFlight = null; });
  }

  // Fire-and-forget refresh if the last check is stale, but always return synchronously with the
  // last known state - callers on the hot tick path must never block on a network round-trip.
  private maybeRefresh(): void {
    if (Date.now() - this.lastCheckedAt > RECHECK_INTERVAL_MS) {
      this.scheduleRefresh();
    }
  }

  private updateStatus(newStatus: KronosStatus) {
    this.status = newStatus;
    eventBus.publish('KRONOS_STATUS_CHANGE', { status: this.status });
  }

  /** Record measured /forecast round-trip (or Python-reported) latency for the status UI. */
  public recordInferenceLatency(ms: number): void {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      this.inferenceTime = Math.round(ms);
    }
  }

  public getStatusReport() {
    this.maybeRefresh();
    const latencyMs = this.inferenceTime > 0 ? this.inferenceTime : null;
    // Operator-facing health: Chronos down is UNAVAILABLE, not a generic FAILED boot lamp.
    const operationalHealth: 'STARTING' | 'RUNNING' | 'UNAVAILABLE' | 'FAILED' =
      this.status === 'Loading...' || this.status === 'Downloading...' || this.status === 'Initializing...'
        ? 'STARTING'
        : this.isAvailable
          ? 'RUNNING'
          : this.status === 'Warning: Kronos unavailable'
            ? 'UNAVAILABLE'
            : 'FAILED';
    return {
      status: this.status,
      operationalHealth,
      version: this.modelVersion,
      memoryUsage: this.memoryUsage,
      gpuUsage: this.gpuUsage,
      inferenceTime: latencyMs,
      // Aliases so dashboard/API consumers that only look for latencyMs / lastInferenceMs
      // (Python /health field name) do not render a blank when inferenceTime alone is set.
      latencyMs,
      lastInferenceMs: latencyMs,
      device: this.device,
      isAvailable: this.isAvailable,
      serviceUrl: SERVICE_URL,
      // Config surfaced for the Kronos dashboard Engine Configuration panel (reviewed JSON).
      forecastHorizon: null as number | null,
      timeframe: null as string | null,
    };
  }

  /** HTTP status route — always re-probe so the Kronos tab is not stuck on a stale boot failure. */
  public async getStatusReportFresh() {
    await this.refreshAvailability();
    return this.getStatusReport();
  }

  public isReady(): boolean {
    this.maybeRefresh();
    return this.isAvailable;
  }

  /**
   * Fail-closed for hard service failures: stop treating Chronos as ready until the next
   * successful /health recheck. Immediately schedules a health probe so a recovered Chronos
   * clears the latch (do not wait the full recheck interval with isAvailable stuck false).
   * Callers must NOT use this for per-symbol timeouts — those stay fail-closed for that
   * forecast only via KronosForecastAgent cooldown.
   */
  public markUnavailable(reason?: string): void {
    this.isAvailable = false;
    this.lastCheckedAt = Date.now();
    this.updateStatus('Warning: Kronos unavailable');
    if (reason) {
      console.warn(`[KronosModelManager] Marked unavailable: ${reason}`);
    }
    // Clear latch ASAP if /health is already healthy again (CPU timeout storms must not stick).
    this.scheduleRefresh();
  }
}
