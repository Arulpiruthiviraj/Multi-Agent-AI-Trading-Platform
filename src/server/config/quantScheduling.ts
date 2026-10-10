import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface QuantSchedulingConfig {
  dynamicSchedulingEnabled: boolean;
  maxCycleDurationMs: number;
  maxSymbolsPerCycle: number;
  maxAdmissionBurst: number;
  historicalRequestTimeoutMs: number;
  historicalMaxPages: number;
  dailyCacheTailRefreshGapMs: number;
  staleCacheRefreshCooldownMs: number;
  admissionLatencyTargetMs: number;
  admissionLatencyMinSamples: number;
  latencyEvidenceWindowMs: number;
  latencyEvidenceRowLimit: number;
}
const raw = loadRepoConfigJson<QuantSchedulingConfig>('quantScheduling.json');
if (typeof raw.dynamicSchedulingEnabled !== 'boolean') throw new Error('quantScheduling.dynamicSchedulingEnabled must be boolean');
for (const key of ['maxCycleDurationMs', 'maxSymbolsPerCycle', 'maxAdmissionBurst', 'historicalRequestTimeoutMs', 'historicalMaxPages', 'dailyCacheTailRefreshGapMs', 'staleCacheRefreshCooldownMs', 'admissionLatencyTargetMs', 'admissionLatencyMinSamples', 'latencyEvidenceWindowMs', 'latencyEvidenceRowLimit'] as const) {
  if (!Number.isSafeInteger(raw[key]) || raw[key] <= 0) throw new Error(`quantScheduling.${key} must be a positive integer`);
}
export const quantScheduling = raw;
