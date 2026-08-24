/**
 * Point-in-time historical Macro releases for FullArgusReplayEngine.ts, mirroring
 * HistoricalNewsProvider.ts's own shape/pattern exactly (id/available/status/note/all(), plus a
 * separate *VisibleAt() filter applying the real cutoff + look-ahead assertion). Reads
 * `historical_macro_releases` (see schema.ts's own header comment on why date columns are
 * epoch-ms INTEGER, not TEXT). Starts empty in every environment until a real historical
 * macro-calendar backfill is run — that backfill is a separate data-sourcing project, not
 * fabricated here. UNAVAILABLE (never a fake "no macro news happened") whenever no real rows
 * exist for the requested window - MacroAgent stays UNAVAILABLE in replay's honesty report in
 * that case, exactly as it already is today.
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { and, gte, lte } from 'drizzle-orm';
import type { InformationCutoff } from './InformationCutoff';

export interface HistoricalMacroRelease {
  eventId: string;
  releaseAtMs: number;
  metric: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  impact: string | null;
}

export interface HistoricalMacroProvider {
  id: string;
  available: boolean;
  status: 'AVAILABLE' | 'HISTORICAL_MACRO_UNAVAILABLE';
  note: string;
  all(): HistoricalMacroRelease[];
}

export function unavailableHistoricalMacroProvider(): HistoricalMacroProvider {
  return {
    id: 'none',
    available: false,
    status: 'HISTORICAL_MACRO_UNAVAILABLE',
    note: 'No real historical macro-release records exist for this window. MacroAgent stays UNAVAILABLE in replay - never a fabricated "no releases" assumption.',
    all: () => [],
  };
}

/** Real DB read - never fabricates a release. Empty result correctly yields the unavailable provider. */
export async function loadHistoricalMacroProvider(startMs: number, endMs: number): Promise<HistoricalMacroProvider> {
  const rows = await db.select().from(schema.historicalMacroReleases).where(
    and(gte(schema.historicalMacroReleases.releaseDateMs, startMs), lte(schema.historicalMacroReleases.releaseDateMs, endMs)),
  );
  if (rows.length === 0) return unavailableHistoricalMacroProvider();
  const releases: HistoricalMacroRelease[] = rows.map((r) => ({
    eventId: r.eventId,
    releaseAtMs: r.releaseDateMs,
    metric: r.metric,
    actual: r.actual,
    forecast: r.forecast,
    previous: r.previous,
    impact: r.impact,
  }));
  return {
    id: 'historical_macro_archive',
    available: true,
    status: 'AVAILABLE',
    note: `${releases.length} real historical macro release(s) loaded for this window.`,
    all: () => releases,
  };
}

/** Point-in-time filter, same contract as HistoricalNewsProvider.ts's newsVisibleAt(). */
export function macroReleasesVisibleAt(provider: HistoricalMacroProvider, cutoff: InformationCutoff): HistoricalMacroRelease[] {
  const t = cutoff.now();
  return provider.all().filter((r) => {
    if (r.releaseAtMs > t) return false;
    cutoff.assertNotFuture(r.releaseAtMs, `macro release ${r.eventId}`);
    return true;
  });
}
