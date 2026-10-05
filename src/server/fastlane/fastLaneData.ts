/**
 * Fast Opportunity Lane — Tier 1 data acquisition.
 *
 * 2026-10-05: A fast candidate must be evaluable WITHOUT a permanent streaming
 * subscription. Tier 1 = fresh single-symbol snapshot (Alpaca IEX REST) + recent
 * bars via the existing HistoricalDataGateway. This reuses the production-proven
 * batch-snapshot plumbing with a single symbol — no new auth, no new endpoints.
 *
 * marketDataType provenance is preserved: snapshots are tagged by source.
 * Delayed data NEVER satisfies the lane's freshness requirements (same structural
 * isolation as the normal path).
 */

import { networkEndpoints } from '../config/networkEndpoints';
import { alpacaFetch } from '../core/alpacaTls';

/** Alpaca API auth headers (same as SnapshotScanner). */
function alpacaAuthHeaders(): Record<string, string> {
  const keyId = process.env.APCA_API_KEY_ID || process.env.ALPACA_API_KEY || '';
  const secret = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY || '';
  return { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret };
}
import { logErrorSafely } from '../core/SecretRedaction';
import { logFastDataRequested, logFastDataReady } from './fastLaneObservability';

export interface Tier1Snapshot {
  symbol: string;
  last: number;
  prevClose: number;
  intradayPctChange: number;
  minuteHigh: number | null;
  minuteLow: number | null;
  dailyVolume: number | null;
  latestQuoteBid: number | null;
  latestQuoteAsk: number | null;
  spreadBps: number | null;
  /** Exchange timestamp of the latest quote (ms epoch), for freshness checks. */
  quoteTimestampMs: number | null;
  fetchedAtMs: number;
  source: 'ALPACA_IEX_SNAPSHOT';
}

/**
 * Fetch a fresh single-symbol snapshot (Tier 1). Does NOT open a WebSocket,
 * does NOT consume a streaming slot. ~10 lines over the existing batch plumbing.
 */
export async function fetchTier1Snapshot(symbol: string): Promise<Tier1Snapshot | null> {
  const sym = symbol.toUpperCase();
  logFastDataRequested('', sym, 'TIER_1');
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const url = `${networkEndpoints.broker.alpaca.dataBaseUrl}/v2/stocks/snapshots?symbols=${encodeURIComponent(sym)}&feed=iex`;
    const res = await alpacaFetch(url, { headers: alpacaAuthHeaders(), signal: controller.signal });
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, Record<string, unknown>>;
    const snap = raw[sym];
    if (!snap) return null;

    const minuteBar = snap.minuteBar as { c?: number; h?: number; l?: number } | undefined;
    const dailyBar = snap.dailyBar as { c?: number; v?: number } | undefined;
    const prevDailyBar = snap.prevDailyBar as { c?: number } | undefined;
    const latestTrade = snap.latestTrade as { p?: number } | undefined;
    const latestQuote = snap.latestQuote as { bp?: number; ap?: number; t?: string } | undefined;

    const prevClose = typeof prevDailyBar?.c === 'number' && prevDailyBar.c > 0 ? prevDailyBar.c : null;
    if (prevClose == null) return null;
    const last =
      (typeof minuteBar?.c === 'number' && minuteBar.c > 0 ? minuteBar.c : null)
      ?? (typeof latestTrade?.p === 'number' && latestTrade.p > 0 ? latestTrade.p : null)
      ?? (typeof dailyBar?.c === 'number' && dailyBar.c > 0 ? dailyBar.c : null);
    if (last == null) return null;

    const bid = typeof latestQuote?.bp === 'number' ? latestQuote.bp : null;
    const ask = typeof latestQuote?.ap === 'number' ? latestQuote.ap : null;
    const spreadBps = bid != null && ask != null && bid > 0 && ask > 0 && ask > bid
      ? ((ask - bid) / ((ask + bid) / 2)) * 10_000
      : null;
    // Crossed quotes are rejected — same rule as the 2026-10-05 P1 fix.
    if (bid != null && ask != null && bid >= ask) return null;

    const quoteTimestampMs = typeof latestQuote?.t === 'string'
      ? Date.parse(latestQuote.t) || null
      : null;

    const result: Tier1Snapshot = {
      symbol: sym,
      last,
      prevClose,
      intradayPctChange: ((last - prevClose) / prevClose) * 100,
      minuteHigh: typeof minuteBar?.h === 'number' ? minuteBar.h : null,
      minuteLow: typeof minuteBar?.l === 'number' ? minuteBar.l : null,
      dailyVolume: typeof dailyBar?.v === 'number' ? dailyBar.v : null,
      latestQuoteBid: bid,
      latestQuoteAsk: ask,
      spreadBps,
      quoteTimestampMs,
      fetchedAtMs: Date.now(),
      source: 'ALPACA_IEX_SNAPSHOT',
    };
    logFastDataReady('', sym, 'TIER_1', Date.now() - startedAt);
    return result;
  } catch (e) {
    logErrorSafely('fastlane tier1 snapshot failed', e);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
