/**
 * Point-in-time historical Fundamental filing snapshots for FullArgusReplayEngine.ts. Unlike
 * News/Macro (event streams, "everything published up to cutoff is visible"), fundamentals are a
 * periodic-snapshot concept: "what was Argus's most recent real filing data for this symbol as of
 * this date" - so the core query here is a latest-snapshot-at-or-before lookup, not a visible-list
 * filter, matching how live FundamentalAgent's own AlphaVantage-backed data actually behaves (a
 * single current snapshot, not a news-like feed). Reads `historical_fundamental_snapshots` (see
 * schema.ts's own header comment on epoch-ms INTEGER date columns). Starts empty until a real
 * historical filings backfill is run - not fabricated here.
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { and, eq, lte, desc } from 'drizzle-orm';
import type { InformationCutoff } from './InformationCutoff';

export interface HistoricalFundamentalSnapshot {
  symbol: string;
  filingAtMs: number;
  peRatio: number | null;
  pbRatio: number | null;
  roe: number | null;
  debtToEquity: number | null;
}

export interface HistoricalFundamentalProvider {
  id: string;
  available: boolean;
  status: 'AVAILABLE' | 'HISTORICAL_FUNDAMENTALS_UNAVAILABLE';
  note: string;
  /** All real snapshots loaded for this provider's requested symbols/window (unfiltered by cutoff). */
  all(): HistoricalFundamentalSnapshot[];
}

export function unavailableHistoricalFundamentalProvider(): HistoricalFundamentalProvider {
  return {
    id: 'none',
    available: false,
    status: 'HISTORICAL_FUNDAMENTALS_UNAVAILABLE',
    note: 'No real historical fundamental filing records exist for these symbols. FundamentalAgent stays UNAVAILABLE in replay - never a fabricated ratio.',
    all: () => [],
  };
}

/** Real DB read across the given symbols, real filings only - never fabricates a snapshot. */
export async function loadHistoricalFundamentalProvider(symbols: string[]): Promise<HistoricalFundamentalProvider> {
  if (symbols.length === 0) return unavailableHistoricalFundamentalProvider();
  const rows: HistoricalFundamentalSnapshot[] = [];
  for (const symbol of symbols) {
    const symbolRows = await db.select().from(schema.historicalFundamentalSnapshots)
      .where(eq(schema.historicalFundamentalSnapshots.symbol, symbol));
    for (const r of symbolRows) {
      rows.push({
        symbol: r.symbol,
        filingAtMs: r.filingDateMs,
        peRatio: r.peRatio,
        pbRatio: r.pbRatio,
        roe: r.roe,
        debtToEquity: r.debtToEquity,
      });
    }
  }
  if (rows.length === 0) return unavailableHistoricalFundamentalProvider();
  return {
    id: 'historical_fundamental_archive',
    available: true,
    status: 'AVAILABLE',
    note: `${rows.length} real historical fundamental snapshot(s) loaded across ${symbols.length} symbol(s).`,
    all: () => rows,
  };
}

/**
 * The most recent real filing at-or-before the replay clock's current time for one symbol - null
 * (never a fabricated ratio) when no qualifying real filing exists yet at that point in the replay.
 */
export function latestFundamentalSnapshotAsOf(
  provider: HistoricalFundamentalProvider,
  cutoff: InformationCutoff,
  symbol: string,
): HistoricalFundamentalSnapshot | null {
  const t = cutoff.now();
  const candidates = provider.all().filter((s) => {
    if (s.symbol !== symbol) return false;
    if (s.filingAtMs > t) return false;
    cutoff.assertNotFuture(s.filingAtMs, `fundamental filing ${symbol}`);
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.filingAtMs - a.filingAtMs);
  return candidates[0];
}

/** Real, read-only DB lookup helper mirroring the query the provider itself uses, for direct use
 *  outside a pre-loaded provider (e.g. a one-off check) - still real data, never fabricated. */
export async function queryLatestFundamentalSnapshot(symbol: string, atOrBeforeMs: number): Promise<HistoricalFundamentalSnapshot | null> {
  const rows = await db.select().from(schema.historicalFundamentalSnapshots)
    .where(and(eq(schema.historicalFundamentalSnapshots.symbol, symbol), lte(schema.historicalFundamentalSnapshots.filingDateMs, atOrBeforeMs)))
    .orderBy(desc(schema.historicalFundamentalSnapshots.filingDateMs))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { symbol: r.symbol, filingAtMs: r.filingDateMs, peRatio: r.peRatio, pbRatio: r.pbRatio, roe: r.roe, debtToEquity: r.debtToEquity };
}
