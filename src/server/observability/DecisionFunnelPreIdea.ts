/**
 * Phase 4A (Decision Funnel instrumentation, 2026-08-26): reconstructs the funnel stages that
 * happen BEFORE a traceId is minted - DISCOVERED / RANKED / PROMOTED / SUBSCRIBED / DATA_READY -
 * from event_traces rows that already exist (OPPORTUNITY_SCAN_COMPLETED, WATCHLIST_SUBSCRIBE_REQUESTED,
 * TRADE_IDEA_REJECTED). getDecisionTrace() in queryTraces.ts already reconstructs everything from
 * IDEA_GENERATED onward via correlationId=traceId; this module is additive, read-only, and does
 * NOT duplicate that logic - it only covers the pre-traceId gap that the 2026-08-26 zero-trade
 * audit had to reconstruct by hand.
 *
 * Honesty contract: a stage is only ever reported RECONSTRUCTED (with the source row it came from)
 * or NOT_RECONSTRUCTIBLE (with an explicit reason) - never fabricated or inferred beyond what the
 * matched row actually says. RANKED/PROMOTED in particular are coarse approximations from
 * SnapshotScanner's shortlist `reason` field (`already_subscribed` implies a prior promotion;
 * `watch_candidate` implies ranked-but-not-yet-promoted) - not a real per-symbol score history,
 * which does not exist prior to this session's own CandidateRankingPanel work (only the latest
 * cycle's top-12 is exposed; full historical per-symbol ranking is a Phase 4C item, not built here).
 */
import { db } from '../db';
import { eventTraces } from '../db/schema';
import { eq, and, lte, gte, desc } from 'drizzle-orm';

export type FunnelStageStatus = 'RECONSTRUCTED' | 'NOT_RECONSTRUCTIBLE';

export interface PreIdeaStage {
  stage: 'DISCOVERED' | 'RANKED' | 'PROMOTED' | 'SUBSCRIBED' | 'DATA_READY';
  status: FunnelStageStatus;
  time: string | null;
  detail: string;
  sourceEventType: string | null;
}

/** Lookback window to search for a preceding scan/subscribe event for this symbol. */
const LOOKBACK_MS = 30 * 60 * 1000; // 30 minutes - scan cycles run every few minutes per config

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function findNearestPrecedingEvent(eventType: string, beforeMs: number): Promise<{ timestamp: number; payload: unknown } | null> {
  const row = await db.select().from(eventTraces)
    .where(and(
      eq(eventTraces.eventType, eventType),
      lte(eventTraces.timestamp, beforeMs),
      gte(eventTraces.timestamp, beforeMs - LOOKBACK_MS),
    ))
    .orderBy(desc(eventTraces.timestamp))
    .limit(1)
    .get();
  if (!row) return null;
  return { timestamp: row.timestamp, payload: parseJson(row.payload) };
}

/**
 * symbol: uppercase ticker. ideaTimestampMs: the TRADE_IDEA_GENERATED timestamp this idea's
 * traceId corresponds to (from getDecisionTrace's own event rows) - the anchor every pre-idea
 * stage is searched backward from.
 */
export async function reconstructPreIdeaStages(symbol: string, ideaTimestampMs: number): Promise<PreIdeaStage[]> {
  const stages: PreIdeaStage[] = [];

  // DISCOVERED / RANKED / PROMOTED all come from the same OPPORTUNITY_SCAN_COMPLETED shortlist.
  const scan = await findNearestPrecedingEvent('OPPORTUNITY_SCAN_COMPLETED', ideaTimestampMs);
  const shortlist = (scan?.payload as { shortlist?: Array<{ symbol: string; reason: string }> } | null)?.shortlist ?? [];
  const entry = shortlist.find((s) => s.symbol === symbol);

  if (scan && entry) {
    stages.push({
      stage: 'DISCOVERED', status: 'RECONSTRUCTED', time: new Date(scan.timestamp).toISOString(),
      detail: `Present in the scan shortlist preceding this idea (reason: ${entry.reason}).`,
      sourceEventType: 'OPPORTUNITY_SCAN_COMPLETED',
    });
    stages.push({
      stage: 'RANKED', status: 'RECONSTRUCTED', time: new Date(scan.timestamp).toISOString(),
      detail: `Approximate only - shortlist inclusion, not a persisted per-symbol score. reason=${entry.reason}.`,
      sourceEventType: 'OPPORTUNITY_SCAN_COMPLETED',
    });
    stages.push({
      stage: 'PROMOTED',
      status: entry.reason === 'already_subscribed' ? 'RECONSTRUCTED' : 'NOT_RECONSTRUCTIBLE',
      time: entry.reason === 'already_subscribed' ? new Date(scan.timestamp).toISOString() : null,
      detail: entry.reason === 'already_subscribed'
        ? 'Already an active subscription by this scan cycle - promoted at or before this point.'
        : `Shortlist reason was "${entry.reason}", not "already_subscribed" - no evidence of promotion prior to this idea.`,
      sourceEventType: 'OPPORTUNITY_SCAN_COMPLETED',
    });
  } else {
    for (const s of ['DISCOVERED', 'RANKED', 'PROMOTED'] as const) {
      stages.push({
        stage: s, status: 'NOT_RECONSTRUCTIBLE', time: null,
        detail: 'No OPPORTUNITY_SCAN_COMPLETED event in the 30-minute lookback window mentioned this symbol.',
        sourceEventType: null,
      });
    }
  }

  const sub = await findNearestPrecedingEvent('WATCHLIST_SUBSCRIBE_REQUESTED', ideaTimestampMs);
  const subPayload = sub?.payload as { symbol?: string } | null;
  if (sub && subPayload?.symbol === symbol) {
    stages.push({
      stage: 'SUBSCRIBED', status: 'RECONSTRUCTED', time: new Date(sub.timestamp).toISOString(),
      detail: 'WATCHLIST_SUBSCRIBE_REQUESTED found for this symbol preceding the idea.',
      sourceEventType: 'WATCHLIST_SUBSCRIBE_REQUESTED',
    });
  } else {
    stages.push({
      stage: 'SUBSCRIBED', status: 'NOT_RECONSTRUCTIBLE', time: null,
      detail: 'No matching WATCHLIST_SUBSCRIBE_REQUESTED in the lookback window - symbol may have been subscribed earlier than the window, or via a curated seed list rather than a discovery event.',
      sourceEventType: null,
    });
  }

  // DATA_READY: inferred from the ABSENCE of a MISSING_PRICE rejection for this symbol at the
  // idea's own timestamp - the idea reaching TRADE_IDEA_GENERATED at all already proves a live
  // price existed (gateTradeIdea's price_validity pre-filter), so this is reported RECONSTRUCTED
  // from that logical guarantee, not a separate event lookup.
  stages.push({
    stage: 'DATA_READY', status: 'RECONSTRUCTED', time: new Date(ideaTimestampMs).toISOString(),
    detail: 'Inferred from the idea itself reaching TRADE_IDEA_GENERATED - gateTradeIdea() requires a finite, positive currentPrice before that event fires.',
    sourceEventType: 'TRADE_IDEA_GENERATED',
  });

  return stages;
}
