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
  /** Off-hours / weekend NewsEngine poll cadence (conservation). */
  newsEngineOffHoursMs: number;
  /** After 09:30 ET, how long staged catalysts may be matched to opening ticks. */
  newsOpenConfluenceWindowMs: number;
  /** ET minutes since midnight when INTRADAY staged catalysts expire (e.g. 630 = 10:30). */
  newsIntradayStageUntilEtMinutes: number;
  rssFeedErrorBackoffMs: number;
  rssFeedFetchTimeoutMs: number;
  chiefTraderWeightSyncMs: number;
  chiefTraderIdeaTtlMs: number;
  systemMetricsMs: number;
  portfolioReconciliationMs: number;
  reconciliationBootWarmupMs: number;
  marketDataReconnectMs: number;
  networkReconnectBackoffMs: number[];
  marketDataCrossCheckMs: number;
  kronosRecheckMs: number;
  kronosPredictionCooldownMs: number;
  kronosHttpTimeoutMs: number;
  /** Max in-flight Chronos /forecast HTTP calls (serialize CPU timeout storms). */
  kronosForecastMaxConcurrent: number;
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
  strategyEngineShadowMs: number;
}

const REQUIRED_KEYS: (keyof RuntimeIntervals)[] = [
  'fundamentalAgentMs', 'macroAgentMs', 'portfolioMonitorMs', 'reflectionEngineMs', 'newsEngineMs',
  'newsEngineOffHoursMs', 'newsOpenConfluenceWindowMs', 'newsIntradayStageUntilEtMinutes',
  'rssFeedErrorBackoffMs', 'rssFeedFetchTimeoutMs',
  'chiefTraderWeightSyncMs', 'chiefTraderIdeaTtlMs', 'systemMetricsMs', 'portfolioReconciliationMs',
  'reconciliationBootWarmupMs', 'marketDataReconnectMs', 'networkReconnectBackoffMs', 'marketDataCrossCheckMs', 'kronosRecheckMs', 'kronosPredictionCooldownMs',
  'kronosHttpTimeoutMs', 'kronosForecastMaxConcurrent', 'openAlicePollMs', 'openAliceRequestTimeoutMs', 'openAliceMcpDefaultTimeoutMs',
  'modelRuntimeProbeTimeoutMs', 'fundamentalsCacheMaxAgeMs', 'macroCacheMaxAgeMs',
  'externalDataRateLimitCooldownMs', 'dbBackupIntervalMs', 'dbBackupRetentionDays',
  'eventStoreMaxRecentEvents', 'eventStoreMaxTraces', 'eventStoreSchemaVersion',
  'agentActivityWindowMs', 'opportunityWindowHours', 'omsFollowUpMinAgeMs', 'omsFollowUpIntervalMs',
  'omsPollForFillTimeoutMs', 'omsPollForFillIntervalMs', 'autoTradeSchedulerMs', 'strategyEngineShadowMs',
];

function loadRuntimeIntervals(): RuntimeIntervals {
  const raw = loadRepoConfigJson<Record<string, unknown>>('runtimeIntervals.json');
  for (const key of REQUIRED_KEYS) {
    if (key === 'networkReconnectBackoffMs') {
      const arr = raw[key];
      if (!Array.isArray(arr) || arr.length === 0 || !arr.every(v => typeof v === 'number' && Number.isFinite(v))) {
        throw new Error('config/runtimeIntervals.json missing numeric array field: networkReconnectBackoffMs');
      }
      continue;
    }
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number)) {
      throw new Error(`config/runtimeIntervals.json missing numeric field: ${key}`);
    }
  }
  return raw as unknown as RuntimeIntervals;
}

export const runtimeIntervals: RuntimeIntervals = loadRuntimeIntervals();
