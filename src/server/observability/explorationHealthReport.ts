/**
 * Phase 18 (2026-09-01 rescue-fairness + exploration-observability mission), Parts 5/6/7/10.
 *
 * The Phase 17 audit had to manually correlate STRATEGY_EXPLORATION_PROMOTED events with a later
 * QUANT_IDEA_DISCARDED_STALE_DATA row for the same symbol by eyeballing adjacent timestamps - real,
 * error-prone, and exactly the kind of join this module now does by a real shared identifier
 * instead: every event this report joins on already carried (or, for rescue grants/denials, now
 * carries after this same phase's MarketDataWorker.ts fix) the SAME traceId QuantSignalAgent mints
 * once per (symbol, evaluation cycle) via generateTraceId() - the same id that is `decisionId`/
 * `correlationId` everywhere else in this codebase (see CLAUDE.md's Decision Trace Schema). No new
 * telemetry system, no fabricated stages - every stage below is a real, already-emitted event or
 * already-persisted row; a stage this report cannot find evidence for is left `null`/`false`, never
 * inferred as having happened.
 *
 * Read-only. Never mutates anything. Never a second decision path.
 */
import { db } from '../db';
import { observabilityEvents, riskAssessments, trades } from '../db/schema';
import { and, eq, gte } from 'drizzle-orm';
import { classifyTradeEnvironment, isReplayTraceId } from '../research/organicPaper';

export interface ExplorationHealthRow {
  traceId: string;
  symbol: string;
  strategyPromoted: string | null;
  naturalTopStrategy: string | null;
  promotedAt: string;
  rescueRequested: boolean;
  rescueGranted: boolean | null;
  rescueDeniedReason: string | null;
  ideaDiscardedStaleData: boolean;
  ideaEmitted: boolean;
  consensusApproved: boolean | null;
  consensusRejectionReason: string | null;
  riskEngineReached: boolean;
  riskApproved: boolean;
  omsOrderPlaced: boolean;
  fillReached: boolean;
  /** 0=fired, 1=strategy evaluated (implicit - promotion itself proves this), 2=valid idea
   *  constructed (survived EV/R:R/cold-start - proven by reaching either the stale-data discard
   *  gate or emission), 3=emitted to consensus, 4=RiskEngine, 5=OMS, 6=fill. Never inferred past
   *  the last stage with real evidence. */
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export interface ExplorationHealthReport {
  windowSinceIso: string;
  rows: ExplorationHealthRow[];
  successRateByStage: Array<{ level: number; label: string; count: number; pctOfLevel0: number }>;
}

const LEVEL_LABELS = [
  'scheduler fired',
  'strategy evaluated',
  'valid idea constructed',
  'emitted to consensus',
  'RiskEngine reached',
  'OMS order placed',
  'paper fill',
] as const;

function extractPromotedStrategies(reasoning: string | null): { promoted: string | null; natural: string | null } {
  if (!reasoning) return { promoted: null, natural: null };
  const m = reasoning.match(/Exploration promoted (\S+) \(setupScore [\d.]+\) over the natural top-ranked (\S+)/);
  return { promoted: m?.[1] ?? null, natural: m?.[2] ?? null };
}

export async function buildExplorationHealthReport(sinceIso: string): Promise<ExplorationHealthReport> {
  const sinceMs = new Date(sinceIso).getTime();

  const promotions = await db.select().from(observabilityEvents).where(
    and(eq(observabilityEvents.eventType, 'STRATEGY_EXPLORATION_PROMOTED'), gte(observabilityEvents.ts, sinceMs)),
  );

  const rows: ExplorationHealthRow[] = [];
  for (const promo of promotions) {
    if (!promo.traceId || !promo.symbol) continue; // cannot correlate without a real traceId - never guessed
    const traceId = promo.traceId;
    let reasoning: string | null = null;
    try { reasoning = JSON.parse(promo.payload as string)?.reasoning ?? null; } catch { /* leave null */ }
    const { promoted, natural } = extractPromotedStrategies(reasoning);

    const rescueEvents = await db.select().from(observabilityEvents).where(
      and(eq(observabilityEvents.traceId, traceId), gte(observabilityEvents.ts, sinceMs)),
    );
    const rescueGrant = rescueEvents.find((e) => e.eventType === 'TEMPORARY_DATA_RESCUE_GRANTED');
    const rescueDenial = rescueEvents.find((e) => e.eventType === 'TEMPORARY_DATA_RESCUE_DENIED');
    const staleDiscard = rescueEvents.find((e) => e.eventType === 'QUANT_IDEA_DISCARDED_STALE_DATA');
    const consensusRow = rescueEvents.find((e) => e.eventType === 'CONSENSUS_TERMINAL_REASON');

    let consensusApproved: boolean | null = null;
    let consensusRejectionReason: string | null = null;
    if (consensusRow) {
      try {
        const p = JSON.parse(consensusRow.payload as string);
        consensusApproved = p.approved === true;
        consensusRejectionReason = p.approved ? null : (p.terminalReasonCode ?? null);
      } catch { /* leave null */ }
    }

    let riskDeniedReason: string | null = null;
    if (rescueDenial) {
      try { riskDeniedReason = JSON.parse(rescueDenial.payload as string)?.reasoning?.match(/denied: (\S+)\.$/)?.[1] ?? null; } catch { /* leave null */ }
    }

    const riskRows = await db.select().from(riskAssessments).where(eq(riskAssessments.traceId, traceId));
    const genuineRisk = riskRows.filter((r) => !isReplayTraceId(r.traceId));
    const tradeRows = await db.select().from(trades).where(eq(trades.traceId, traceId));
    const genuineTrades = tradeRows.filter((t) => classifyTradeEnvironment(t) !== 'REPLAY');

    const riskEngineReached = genuineRisk.length > 0;
    const riskApproved = genuineRisk.some((r) => r.approved);
    const omsOrderPlaced = genuineTrades.length > 0;
    const fillReached = genuineTrades.some((t) => t.status === 'FILLED');
    const ideaEmitted = !!consensusRow;
    const ideaDiscardedStaleData = !!staleDiscard;

    let level: ExplorationHealthRow['level'] = 1; // promotion itself proves the strategy was evaluated
    if (ideaEmitted || ideaDiscardedStaleData) level = 2; // reached the point of a constructed idea either way
    if (ideaEmitted) level = 3;
    if (riskEngineReached) level = 4;
    if (omsOrderPlaced) level = 5;
    if (fillReached) level = 6;

    rows.push({
      traceId,
      symbol: promo.symbol,
      strategyPromoted: promoted,
      naturalTopStrategy: natural,
      promotedAt: new Date(promo.ts).toISOString(),
      rescueRequested: !!rescueGrant || !!rescueDenial,
      rescueGranted: rescueGrant ? true : rescueDenial ? false : null,
      rescueDeniedReason: riskDeniedReason,
      ideaDiscardedStaleData,
      ideaEmitted,
      consensusApproved,
      consensusRejectionReason,
      riskEngineReached,
      riskApproved,
      omsOrderPlaced,
      fillReached,
      level,
    });
  }

  const level0Count = rows.length;
  const successRateByStage = LEVEL_LABELS.map((label, level) => ({
    level,
    label,
    count: rows.filter((r) => r.level >= level).length,
    pctOfLevel0: level0Count > 0 ? Number(((rows.filter((r) => r.level >= level).length / level0Count) * 100).toFixed(1)) : 0,
  }));

  return { windowSinceIso: sinceIso, rows, successRateByStage };
}

export function formatExplorationHealthReport(r: ExplorationHealthReport): string {
  const lines = [
    'EXPLORATION HEALTH (why did each promotion succeed or fail downstream?)',
    '------------------------------------------------------------------------',
    `Window since: ${r.windowSinceIso}`,
    '',
  ];
  if (r.rows.length === 0) {
    lines.push('(no exploration promotions in this window)');
    return lines.join('\n');
  }
  lines.push(
    'PromotedAt'.padEnd(26) + 'Symbol'.padEnd(8) + 'Strategy'.padEnd(22) + 'Rescue'.padEnd(20) + 'Idea'.padEnd(12) + 'Consensus'.padEnd(14) + 'Risk'.padEnd(7) + 'OMS'.padEnd(6) + 'Fill'.padEnd(6) + 'Level',
  );
  for (const row of r.rows) {
    const rescueCol = row.rescueRequested ? (row.rescueGranted ? 'GRANTED' : `DENIED(${row.rescueDeniedReason ?? '?'})`) : 'not needed';
    const ideaCol = row.ideaEmitted ? 'EMITTED' : row.ideaDiscardedStaleData ? 'DISCARDED' : '-';
    const consensusCol = row.consensusApproved === null ? '-' : row.consensusApproved ? 'APPROVED' : `REJECTED(${row.consensusRejectionReason ?? '?'})`;
    lines.push(
      row.promotedAt.padEnd(26)
      + row.symbol.padEnd(8)
      + (row.strategyPromoted ?? '?').padEnd(22)
      + rescueCol.padEnd(20)
      + ideaCol.padEnd(12)
      + consensusCol.padEnd(14)
      + String(row.riskEngineReached).padEnd(7)
      + String(row.omsOrderPlaced).padEnd(6)
      + String(row.fillReached).padEnd(6)
      + String(row.level),
    );
  }
  lines.push('', 'SUCCESS RATE BY STAGE (never "successful" merely because an earlier stage completed)', '------------------------------------------------------------------------------------');
  for (const s of r.successRateByStage) {
    lines.push(`Level ${s.level} (${s.label}): ${s.count}/${r.rows.length} (${s.pctOfLevel0}%)`);
  }
  return lines.join('\n');
}
