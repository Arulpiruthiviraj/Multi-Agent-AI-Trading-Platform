import { eventBus } from '../../core/EventBus';
import { preferIpv4Loopback } from '../../ai/preferIpv4Loopback';
import { runtimeIntervals } from '../../config/runtimeIntervals';

export type KronosStatus = 'Loading...' | 'Downloading...' | 'Initializing...' | 'Ready' | 'Warning: Kronos unavailable';

function resolveChronosServiceUrl(): string {
  const raw = process.env.LOCAL_AI_SERVICE_URL || 'http://127.0.0.1:8008';
  // Legacy docs used :8000; Chronos always serves LOCAL_AI_SERVICE_PORT (default 8008).
  return preferIpv4Loopback(raw.replace(/:8000(?=\/|$)/, ':8008'));
}

const SERVICE_URL = resolveChronosServiceUrl();
// Re-checked lazily rather than once at boot - the local inference service (scripts/
// local_ai_service.py) is meant to be started/stopped independently of the Node process, like
// Ollama. A one-shot boot-time check would permanently report unavailable if the service was
// started a moment after this process, even once it's actually up and reachable.
const RECHECK_INTERVAL_MS = runtimeIntervals.kronosRecheckMs;

export class KronosModelManager {
  private status: KronosStatus = 'Loading...';
  private modelVersion: string = 'unknown';
  private isAvailable: boolean = false;
  private memoryUsage: string | null = null;
  private gpuUsage: string | null = null;
  private inferenceTime: number = 0;
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
      this.updateStatus('Ready');
      console.log(`[KronosModelManager] Local Chronos inference service reachable at ${SERVICE_URL} (${this.modelVersion}).`);
    } catch (e: any) {
      this.isAvailable = false;
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

  public getStatusReport() {
    this.maybeRefresh();
    return {
      status: this.status,
      version: this.modelVersion,
      memoryUsage: this.memoryUsage,
      gpuUsage: this.gpuUsage,
      inferenceTime: this.inferenceTime,
      isAvailable: this.isAvailable,
      serviceUrl: SERVICE_URL,
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
}
