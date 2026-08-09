import { eventBus } from '../../core/EventBus';

export type KronosStatus = 'Loading...' | 'Downloading...' | 'Initializing...' | 'Ready' | 'Warning: Kronos unavailable';

export class KronosModelManager {
  private status: KronosStatus = 'Loading...';
  private modelVersion: string = 'Kronos-12B-KLine (fallback)';
  private isAvailable: boolean = false;
  private memoryUsage: string = '0 MB';
  private gpuUsage: string = '0%';
  private inferenceTime: number = 0;

  constructor() {}

  public async initialize(): Promise<void> {
    // KronosInference.predict()/batchPredict() unconditionally throw KRONOS_UNAVAILABLE - there is
    // no Python/PyTorch inference service to connect to. This used to fake a "Downloading... ->
    // Initializing... -> Ready" sequence with hardcoded GPU/memory/inference-time numbers regardless
    // of that. Report the real state instead: never available, no fabricated telemetry.
    this.isAvailable = false;
    this.updateStatus('Warning: Kronos unavailable');
    console.warn('[KronosModelManager] No Kronos inference service configured - reporting unavailable.');
  }
  private updateStatus(newStatus: KronosStatus) {
    this.status = newStatus;
    eventBus.publish('KRONOS_STATUS_CHANGE', { status: this.status });
  }

  public getStatusReport() {
    return {
      status: this.status,
      version: this.modelVersion,
      memoryUsage: this.memoryUsage,
      gpuUsage: this.gpuUsage,
      inferenceTime: this.inferenceTime,
      isAvailable: this.isAvailable
    };
  }

  public isReady(): boolean {
    return this.isAvailable;
  }
}
