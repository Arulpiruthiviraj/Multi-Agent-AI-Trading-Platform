/**
 * Loads config/runtimeIntervals.json. Cadences and caps for periodic workers.
 * Missing required keys fail boot.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface RuntimeIntervals {
  fundamentalAgentMs: number;
  macroAgentMs: number;
  portfolioMonitorMs: number;
  reflectionEngineMs: number;
  newsEngineMs: number;
  chiefTraderWeightSyncMs: number;
  chiefTraderIdeaTtlMs: number;
  systemMetricsMs: number;
  portfolioReconciliationMs: number;
  marketDataReconnectMs: number;
  marketDataCrossCheckMs: number;
  kronosRecheckMs: number;
  kronosPredictionCooldownMs: number;
  kronosHttpTimeoutMs: number;
  openAlicePollMs: number;
  openAliceRequestTimeoutMs: number;
  openAliceMcpDefaultTimeoutMs: number;
  modelRuntimeProbeTimeoutMs: number;
  fundamentalsCacheMaxAgeMs: number;
  macroCacheMaxAgeMs: number;
  externalDataRateLimitCooldownMs: number;
  dbBackupIntervalMs: number;
  dbBackupRetentionDays: number;
  eventStoreMaxRecentEvents: number;
  eventStoreMaxTraces: number;
  eventStoreSchemaVersion: number;
  agentActivityWindowMs: number;
  opportunityWindowHours: number;
  omsFollowUpMinAgeMs: number;
  omsFollowUpIntervalMs: number;
  omsPollForFillTimeoutMs: number;
  omsPollForFillIntervalMs: number;
  autoTradeSchedulerMs: number;
}

const REQUIRED_KEYS: (keyof RuntimeIntervals)[] = [
  'fundamentalAgentMs', 'macroAgentMs', 'portfolioMonitorMs', 'reflectionEngineMs', 'newsEngineMs',
  'chiefTraderWeightSyncMs', 'chiefTraderIdeaTtlMs', 'systemMetricsMs', 'portfolioReconciliationMs',
  'marketDataReconnectMs', 'marketDataCrossCheckMs', 'kronosRecheckMs', 'kronosPredictionCooldownMs',
  'kronosHttpTimeoutMs', 'openAlicePollMs', 'openAliceRequestTimeoutMs', 'openAliceMcpDefaultTimeoutMs',
  'modelRuntimeProbeTimeoutMs', 'fundamentalsCacheMaxAgeMs', 'macroCacheMaxAgeMs',
  'externalDataRateLimitCooldownMs', 'dbBackupIntervalMs', 'dbBackupRetentionDays',
  'eventStoreMaxRecentEvents', 'eventStoreMaxTraces', 'eventStoreSchemaVersion',
  'agentActivityWindowMs', 'opportunityWindowHours', 'omsFollowUpMinAgeMs', 'omsFollowUpIntervalMs',
  'omsPollForFillTimeoutMs', 'omsPollForFillIntervalMs', 'autoTradeSchedulerMs',
];

function loadRuntimeIntervals(): RuntimeIntervals {
  const raw = loadRepoConfigJson<Record<string, unknown>>('runtimeIntervals.json');
  for (const key of REQUIRED_KEYS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number)) {
      throw new Error(`config/runtimeIntervals.json missing numeric field: ${key}`);
    }
  }
  return raw as unknown as RuntimeIntervals;
}

export const runtimeIntervals: RuntimeIntervals = loadRuntimeIntervals();
