/**
 * Live, fire-and-forget PIT ledger writes.
 * Never blocks EventBus → ChiefTrader → RiskEngine → OMS.
 * Never invents FinBERT/LLM text. Look-ahead is rejected by HistoricalDataGateway.
 *
 * asOfMs is when Argus observed/computed the fact (wall clock). publishedAtMs is when
 * the fact existed (article time or the same clock for a live consensus). Replay may
 * only read rows with both timestamps <= the simulated bar.
 */
import { historicalDataGateway } from './HistoricalDataGateway';

export type PitLiveKind = 'NEWS' | 'NEWS_AGENT' | 'CHIEF_TRADER' | 'AGENT_REASONING';

export interface PitLiveRecord {
  kind: PitLiveKind;
  symbol: string;
  publishedAtMs?: number;
  agent?: string;
  side?: 'BUY' | 'SELL' | 'HOLD';
  confidence?: number;
  finbertScore?: number;
  impactScore?: number;
  payloadJson?: string;
  source?: string;
}

function truncatePayload(payloadJson: string | undefined): string | undefined {
  if (!payloadJson) return undefined;
  return payloadJson.length > 2000 ? payloadJson.slice(0, 2000) : payloadJson;
}

export function resolveLivePitTimes(publishedAtMs: number | undefined, nowMs: number): { publishedAtMs: number; asOfMs: number } | null {
  if (!Number.isFinite(nowMs)) return null;
  const published = publishedAtMs === undefined ? nowMs : publishedAtMs;
  if (!Number.isFinite(published) || published > nowMs) return null;
  return { publishedAtMs: published, asOfMs: nowMs };
}

export function recordPitLive(entry: PitLiveRecord): void {
  const times = resolveLivePitTimes(entry.publishedAtMs, Date.now());
  if (!times) return;
  if (!entry.symbol || typeof entry.symbol !== 'string') return;

  void historicalDataGateway.ingestPitLedgerEntry({
    asOfMs: times.asOfMs,
    publishedAtMs: times.publishedAtMs,
    symbol: entry.symbol,
    kind: entry.kind,
    agent: entry.agent,
    side: entry.side,
    confidence: entry.confidence,
    finbertScore: entry.finbertScore,
    impactScore: entry.impactScore,
    payloadJson: truncatePayload(entry.payloadJson),
    source: entry.source ?? 'live',
  }).catch((e) => {
    console.error('[PitLedger] live ingest failed', e);
  });
}
