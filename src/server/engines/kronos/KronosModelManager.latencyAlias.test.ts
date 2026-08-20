import { describe, it, expect, beforeEach } from 'vitest';
import { KronosModelManager } from './KronosModelManager';

describe('KronosModelManager latency aliases', () => {
  beforeEach(() => {
    // no-op — each test constructs a fresh manager
  });

  it('exposes latencyMs and lastInferenceMs aliases alongside inferenceTime', () => {
    const mgr = new KronosModelManager();
    mgr.recordInferenceLatency(718);
    const report = mgr.getStatusReport();
    expect(report.inferenceTime).toBe(718);
    expect(report.latencyMs).toBe(718);
    expect(report.lastInferenceMs).toBe(718);
  });

  it('keeps latency fields null until a real inference is recorded', () => {
    const mgr = new KronosModelManager();
    const report = mgr.getStatusReport();
    expect(report.inferenceTime).toBeNull();
    expect(report.latencyMs).toBeNull();
    expect(report.lastInferenceMs).toBeNull();
  });
});
