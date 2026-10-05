import { loadRepoConfigJson } from './loadRepoConfigJson';

const raw = loadRepoConfigJson<Record<string, number>>('dataTransportLimits.json');
const keys = ['requestTimeoutMs', 'historyTimeoutMs', 'maxHistoryPages', 'historyPageSize',
  'advCalendarLookbackMultiplier', 'webhookTimeoutMs', 'webhookMaxConcurrent',
  'wsSendHighWaterBytes', 'wsKeepaliveIntervalMs', 'wsCongestedIntervalsBeforeTerminate'] as const;
for (const key of keys) {
  if (!Number.isSafeInteger(raw[key]) || raw[key] <= 0) throw new Error(`Invalid dataTransportLimits.${key}`);
}
export const dataTransportLimits = raw as Record<typeof keys[number], number>;
