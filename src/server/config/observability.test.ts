import { describe, it, expect } from 'vitest';
import { observabilityConfig } from './observability';
import { loadRepoConfigJson } from './loadRepoConfigJson';

describe('observability.json', () => {
  it('loads the same file production uses — no TS literals for retention/sampling', () => {
    const raw = loadRepoConfigJson<typeof observabilityConfig>('observability.json');
    expect(observabilityConfig.retentionDays).toBe(raw.retentionDays);
    expect(observabilityConfig.marketDataSampleEveryN).toBe(raw.marketDataSampleEveryN);
    expect(observabilityConfig.processTelemetryIntervalMs).toBe(raw.processTelemetryIntervalMs);
    expect(observabilityConfig.processTelemetryRingSize).toBe(raw.processTelemetryRingSize);
    expect(observabilityConfig.maxQueueSize).toBe(raw.maxQueueSize);
    expect(observabilityConfig.batchFlushMs).toBe(raw.batchFlushMs);
    expect(observabilityConfig.safetyMinLevel).toBe('INFO');
    expect(observabilityConfig.eventTaxonomy.KILL_SWITCH_TRIGGERED.defaultLevel).toBe('ERROR');
    expect(observabilityConfig.eventTaxonomy.RISK_GATE_EVALUATED.category).toBe('RISK');
  });
});
