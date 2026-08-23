/**
 * In-memory campaign effort telemetry for the current NY trading date.
 * Observability only — never sizes, never emits TRADE_IDEA_GENERATED, never lowers consensus.
 */
import { getTradingDateStr } from '../core/TradingCalendar';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingSafety } from '../config/tradingSafety';

export interface CampaignEffortSnapshot {
  tradingDate: string;
  scansPerformed: number;
  strategiesEvaluated: number;
  strategiesRejected: number;
  nearMissConsensus: number;
  confluenceNudges: number;
  watchlistSubscribes: number;
  lastEmitAt: string | null;
}

const nearMissLow = 0.65;
const nearMissHighExclusive = () => tradingSafety.consensusApprovalThreshold;

let day = getTradingDateStr();
let scansPerformed = 0;
let strategiesEvaluated = 0;
let strategiesRejected = 0;
let nearMissConsensus = 0;
let confluenceNudges = 0;
let watchlistSubscribes = 0;
let lastEmitAt: string | null = null;

function rollDay(now = new Date()): void {
  const today = getTradingDateStr(now);
  if (today === day) return;
  day = today;
  scansPerformed = 0;
  strategiesEvaluated = 0;
  strategiesRejected = 0;
  nearMissConsensus = 0;
  confluenceNudges = 0;
  watchlistSubscribes = 0;
  lastEmitAt = null;
}

export function resetCampaignEffortForTests(): void {
  day = getTradingDateStr();
  scansPerformed = 0;
  strategiesEvaluated = 0;
  strategiesRejected = 0;
  nearMissConsensus = 0;
  confluenceNudges = 0;
  watchlistSubscribes = 0;
  lastEmitAt = null;
}

export function recordCampaignScan(count = 1): void {
  rollDay();
  scansPerformed += count;
}

export function recordCampaignStrategyEval(opts: { evaluated: number; rejected: number }): void {
  rollDay();
  strategiesEvaluated += opts.evaluated;
  strategiesRejected += opts.rejected;
}

export function recordCampaignNearMissConsensus(confidence: number): void {
  rollDay();
  const hi = nearMissHighExclusive();
  if (confidence >= nearMissLow && confidence < hi) {
    nearMissConsensus += 1;
  }
}

export function recordCampaignConfluenceNudge(): void {
  rollDay();
  confluenceNudges += 1;
}

export function recordCampaignWatchlistSubscribe(count = 1): void {
  rollDay();
  watchlistSubscribes += count;
}

export function getCampaignEffortSnapshot(now = new Date()): CampaignEffortSnapshot {
  rollDay(now);
  return {
    tradingDate: day,
    scansPerformed,
    strategiesEvaluated,
    strategiesRejected,
    nearMissConsensus,
    confluenceNudges,
    watchlistSubscribes,
    lastEmitAt,
  };
}

export function emitCampaignEffortTelemetry(extra: Record<string, unknown> = {}): CampaignEffortSnapshot {
  const snap = getCampaignEffortSnapshot();
  lastEmitAt = new Date().toISOString();
  try {
    eventBus.emit(EVENTS.CAMPAIGN_EFFORT_TELEMETRY, {
      ...snap,
      lastEmitAt,
        nearMissBand: [nearMissLow, nearMissHighExclusive()],
      ...extra,
    });
  } catch {
    /* fail-open */
  }
  return { ...snap, lastEmitAt };
}
