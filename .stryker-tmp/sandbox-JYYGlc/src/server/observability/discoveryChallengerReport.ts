/**
 * 2026-09-30 (Discovery Challenger Observability Hardening,
 * ARGUS_CHALLENGER_SELECTION_FORENSIC_2026-09-29.md follow-up).
 *
 * Read-only report over the structured events OpportunityDiscovery.ts's runOpportunityScan() now
 * emits every cycle (discovery_challenger_cycle_snapshot / discovery_challenger_swap_outcome /
 * subscription_priority_decision's new reasonCode field) - no new tracking, no new DB table, same
 * observability_events store and query pattern explorationHealthReport.ts already uses. Never
 * mutates anything, never touches the real hot-swap decision.
 */
// @ts-nocheck

import { db } from '../db';
import { observabilityEvents } from '../db/schema';
import { and, eq, gte, inArray } from 'drizzle-orm';

export interface DiscoveryChallengerMissedRow {
  symbol: string;
  missedCount: number;
  bestRank: number | null;
  averageRank: number | null;
}

export interface DiscoveryChallengerReport {
  windowSinceIso: string;
  cyclesConsidered: number;
  cyclesBlockedBySwapPacing: number;
  totalAdmitted: number;
  totalPositivelyScored: number;
  totalZeroScored: number;
  totalTruncated: number;
  totalPromoted: number;
  totalSwapCapBlocked: number;
  totalNotEvictable: number;
  topMissedChallengers: DiscoveryChallengerMissedRow[];
}

function parsePayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'string') return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function buildDiscoveryChallengerReport(sinceIso: string): Promise<DiscoveryChallengerReport> {
  const sinceMs = new Date(sinceIso).getTime();

  const snapshotRows = await db.select().from(observabilityEvents).where(
    and(eq(observabilityEvents.eventType, 'DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT'), gte(observabilityEvents.ts, sinceMs)),
  );
  const swapOutcomeRows = await db.select().from(observabilityEvents).where(
    and(eq(observabilityEvents.eventType, 'DISCOVERY_CHALLENGER_SWAP_OUTCOME'), gte(observabilityEvents.ts, sinceMs)),
  );
  const decisionRows = await db.select().from(observabilityEvents).where(
    and(inArray(observabilityEvents.eventType, ['SUBSCRIPTION_PROMOTED', 'SUBSCRIPTION_NOT_PROMOTED']), gte(observabilityEvents.ts, sinceMs)),
  );

  let totalAdmitted = 0;
  let totalPositivelyScored = 0;
  let totalZeroScored = 0;
  let totalSurvived = 0;
  const rankBySymbol = new Map<string, number[]>();
  const missedSymbols = new Map<string, number>();

  for (const row of snapshotRows) {
    const p = parsePayload(row.payload);
    if (!p) continue;
    totalAdmitted += Number(p.totalShortlisted) || 0;
    totalPositivelyScored += Number(p.eligibleForChallengerScoring) || 0;
    totalZeroScored += Number(p.zeroScoreOrExcludedCount) || 0;
    totalSurvived += Number(p.survivedTruncationCount) || 0;
    const candidates = Array.isArray(p.candidates) ? p.candidates as Array<Record<string, unknown>> : [];
    for (const c of candidates) {
      if (typeof c.symbol !== 'string' || typeof c.rankBeforeTruncation !== 'number') continue;
      if (!rankBySymbol.has(c.symbol)) rankBySymbol.set(c.symbol, []);
      rankBySymbol.get(c.symbol)!.push(c.rankBeforeTruncation);
      if (c.survivedTruncation === false) {
        missedSymbols.set(c.symbol, (missedSymbols.get(c.symbol) ?? 0) + 1);
      }
    }
  }
  const totalTruncated = Math.max(0, totalPositivelyScored - totalSurvived);

  let cyclesBlockedBySwapPacing = 0;
  for (const row of swapOutcomeRows) {
    const p = parsePayload(row.payload);
    if (!p) continue;
    // A cycle is "blocked by swap pacing" when a real swap budget existed but was fully consumed -
    // the same real condition that produces SWAP_CAP_REACHED for any candidate ranked after it.
    if ((Number(p.effectiveSwapBudget) || 0) > 0 && Number(p.swapsRemaining) === 0) cyclesBlockedBySwapPacing += 1;
  }

  let totalPromoted = 0;
  let totalSwapCapBlocked = 0;
  let totalNotEvictable = 0;
  for (const row of decisionRows) {
    const p = parsePayload(row.payload);
    if (!p) continue;
    if (row.eventType === 'SUBSCRIPTION_PROMOTED' && p.reasonCode === 'CHALLENGER_SELECTED') totalPromoted += 1;
    if (p.reasonCode === 'SWAP_CAP_REACHED') totalSwapCapBlocked += 1;
    if (p.reasonCode === 'INCUMBENT_NOT_EVICTABLE') totalNotEvictable += 1;
  }

  const topMissedChallengers: DiscoveryChallengerMissedRow[] = [...missedSymbols.entries()]
    .map(([symbol, missedCount]) => {
      const ranks = rankBySymbol.get(symbol) ?? [];
      const bestRank = ranks.length > 0 ? Math.min(...ranks) : null;
      const averageRank = ranks.length > 0 ? Number((ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1)) : null;
      return { symbol, missedCount, bestRank, averageRank };
    })
    .sort((a, b) => b.missedCount - a.missedCount || (a.bestRank ?? Infinity) - (b.bestRank ?? Infinity))
    .slice(0, 20);

  return {
    windowSinceIso: sinceIso,
    cyclesConsidered: snapshotRows.length,
    cyclesBlockedBySwapPacing,
    totalAdmitted,
    totalPositivelyScored,
    totalZeroScored,
    totalTruncated,
    totalPromoted,
    totalSwapCapBlocked,
    totalNotEvictable,
    topMissedChallengers,
  };
}

export function formatDiscoveryChallengerReport(r: DiscoveryChallengerReport): string {
  const lines = [
    'DISCOVERY CHALLENGERS (admission -> scoring -> truncation -> swap-budget -> promotion)',
    '----------------------------------------------------------------------------------------',
    `Window since: ${r.windowSinceIso}`,
    `Cycles considered: ${r.cyclesConsidered}`,
    `Cycles blocked by swap pacing (budget fully consumed): ${r.cyclesBlockedBySwapPacing}`,
    '',
    `Admitted (shortlisted, sum across cycles): ${r.totalAdmitted}`,
    `Positively scored (real evidence): ${r.totalPositivelyScored}`,
    `Zero scored (no evidence, excluded before challenger ranking): ${r.totalZeroScored}`,
    `Truncated (positive score, ranked outside the challenger limit): ${r.totalTruncated}`,
    `Promoted (won a swap): ${r.totalPromoted}`,
    `Swap-cap blocked (survived truncation, budget exhausted first): ${r.totalSwapCapBlocked}`,
    `Not evictable (no eligible incumbent to displace): ${r.totalNotEvictable}`,
    '',
    'TOP MISSED CHALLENGERS (positive real evidence, truncated out of the challenger limit at least once)',
  ];
  if (r.topMissedChallengers.length === 0) {
    lines.push('(none in this window)');
  } else {
    lines.push('Symbol'.padEnd(10) + 'MissedCycles'.padEnd(14) + 'BestRank'.padEnd(10) + 'AvgRank');
    for (const m of r.topMissedChallengers) {
      lines.push(
        m.symbol.padEnd(10) + String(m.missedCount).padEnd(14) + String(m.bestRank ?? '-').padEnd(10) + String(m.averageRank ?? '-'),
      );
    }
  }
  return lines.join('\n');
}
