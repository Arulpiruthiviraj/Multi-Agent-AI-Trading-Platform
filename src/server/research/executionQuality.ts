/**
 * Execution Quality / Slippage (Master Transformation Mandate Part 16, "Is execution destroying
 * alpha?" - Part 32 final acceptance question #18). Previously genuinely unanswerable: CLAUDE.md's
 * own Frontend Honesty table documented "no slippage field (proposal price not persisted)" because
 * `trades.price` is mutable - OrderManagement.ts overwrites it with the broker's ack/fill price
 * once an order progresses, destroying the original decision-time price before any fill existed to
 * compare it against. `trades.arrival_price` (added this session, schema.ts) is written once at
 * insert and never touched by any later `.update(trades)` call, so this is now a real, provable
 * comparison - not an estimate.
 *
 * Slippage sign convention: positive always means "worse than the price the decision was made at,"
 * regardless of side - a BUY that filled higher than arrival, or a SELL that filled lower than
 * arrival, both report positive slippage. This lets the summary's mean/median answer "is execution
 * destroying alpha" as a single signed number rather than requiring a side-by-side read.
 *
 * Real provenance only: rows with no `arrivalPrice` (legacy trades predating this column,
 * EXTERNAL_MANUAL inbound orders with no Argus-side proposal) or no matching `fills` row are
 * excluded, never backfilled with a guess.
 */
import { db } from '../db';
import { trades, fills } from '../db/schema';
import { and, isNotNull, inArray, desc, sql, getTableColumns } from 'drizzle-orm';

export const EXECUTION_EVIDENCE_CLASSES = ['PAPER_ORGANIC', 'PAPER_MANUAL', 'PAPER_UNATTRIBUTED', 'REPLAY', 'BACKTEST', 'SIMULATION', 'LIVE', 'UNKNOWN'] as const;
export type ExecutionEvidenceClass = typeof EXECUTION_EVIDENCE_CLASSES[number];

// Attribution needs affirmative persisted evidence. A PAPER label alone does not prove an
// organic decision, and the operator pipeline also creates an approved consensus record.
// Classify in SQL so a scope's LIMIT cannot be consumed by more recent replay/manual rows.
// Explicit outer qualification in subqueries is essential: Drizzle's single-table SELECT
// projection strips Column qualifiers, which otherwise makes transaction_id self-referential.
const evidenceClass = sql<ExecutionEvidenceClass>`CASE
  WHEN upper(coalesce(${trades.executionEnvironment}, '')) IN ('SIMULATION', 'SYNTHETIC', 'HISTORICAL_SIMULATION')
    OR ${trades.brokerId} = 'internal_paper' THEN 'SIMULATION'
  WHEN upper(coalesce(${trades.executionEnvironment}, '')) IN ('REPLAY', 'HISTORICAL_REPLAY')
    OR ${trades.brokerId} = 'historical_replay' THEN 'REPLAY'
  WHEN upper(${trades.executionEnvironment}) = 'BACKTEST' THEN 'BACKTEST'
  WHEN upper(${trades.executionEnvironment}) = 'LIVE' THEN 'LIVE'
  WHEN upper(${trades.executionEnvironment}) = 'PAPER' THEN CASE
    WHEN lower(coalesce(${trades.traceId}, '')) LIKE 'manual-override-%'
      OR lower(coalesce(${trades.traceId}, '')) LIKE 'pipeline-buy-%'
      OR lower(coalesce(${trades.traceId}, '')) LIKE 'pipeline-sell-%'
      OR upper(coalesce(${trades.reasoning}, '')) LIKE '%SOURCE: MANUAL_OVERRIDE%'
      OR upper(coalesce(${trades.reasoning}, '')) LIKE '%SOURCE: EXTERNAL_MANUAL%'
      OR EXISTS (SELECT 1 FROM consensus_evidence e WHERE e.transaction_id = ${sql.raw('"trades"."transaction_id"')} AND e.agent = 'ManualOverride')
      THEN 'PAPER_MANUAL'
    WHEN ${trades.traceId} IS NOT NULL AND length(${trades.traceId}) > 0
      AND lower(${trades.traceId}) NOT GLOB 'test*'
      AND lower(${trades.traceId}) NOT GLOB 'qa-*'
      AND lower(${trades.traceId}) NOT GLOB 'gates-*'
      AND lower(${trades.traceId}) NOT GLOB 'crash-*'
      AND lower(${trades.traceId}) NOT GLOB 'lifecycle-*'
      AND lower(${trades.traceId}) NOT GLOB 'vitest*'
      AND lower(${trades.traceId}) NOT GLOB '*diag*'
      AND lower(${trades.traceId}) NOT GLOB 'replay-*'
      AND upper(${sql.raw('"trades"."symbol"')}) NOT GLOB 'DIAG*'
      AND ${trades.brokerId} IN ('alpaca', 'ibkr', 'ibkr_gateway', 'ibkr_web', 'coinbase', 'questrade')
      AND EXISTS (SELECT 1 FROM consensus_decisions c WHERE c.transaction_id = ${sql.raw('"trades"."transaction_id"')}
        AND c.approved = 1 AND c.symbol = ${sql.raw('"trades"."symbol"')} AND c.side = ${sql.raw('"trades"."side"')})
      AND EXISTS (SELECT 1 FROM consensus_evidence e WHERE e.transaction_id = ${sql.raw('"trades"."transaction_id"')}
        AND e.agent <> 'ManualOverride' AND length(e.agent) > 0 AND e.agreed = 1 AND e.side = ${sql.raw('"trades"."side"')})
      THEN 'PAPER_ORGANIC'
    ELSE 'PAPER_UNATTRIBUTED' END
  ELSE 'UNKNOWN' END`;

export interface ExecutionQualityRow {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: string;
  arrivalPrice: number;
  avgFillPrice: number;
  filledQuantity: number;
  /** Positive = worse than arrival (paid more on BUY, received less on SELL). Negative = better. */
  slippagePerShare: number;
  slippageBps: number;
  submittedAt: string | null;
  firstFillAt: string | null;
  submissionToFirstFillMs: number | null;
  quantStrategyId: string | null;
  executionEnvironment: string | null;
  evidenceClass: ExecutionEvidenceClass;
}

export interface ExecutionQualitySummary {
  evidenceClass: ExecutionEvidenceClass;
  excludedRowCount: number;
  n: number;
  meanSlippageBps: number | null;
  medianSlippageBps: number | null;
  meanSlippagePerShare: number | null;
  meanSubmissionToFirstFillMs: number | null;
  positiveSlippageCount: number; // worse than arrival
  negativeSlippageCount: number; // better than arrival
}

export async function buildExecutionQualityReport(limit = 500, scope?: ExecutionEvidenceClass): Promise<ExecutionQualityRow[]> {
  const boundedLimit = Number.isFinite(limit) ? Math.min(2000, Math.max(1, Math.floor(limit))) : 500;
  const tradeRows = await db.select({ ...getTableColumns(trades), evidenceClass }).from(trades)
    .where(and(isNotNull(trades.arrivalPrice), inArray(trades.status, ['FILLED', 'PARTIALLY_FILLED']),
      scope ? sql`${evidenceClass} = ${scope}` : undefined))
    .orderBy(desc(trades.timestamp))
    .limit(boundedLimit)
    .all();
  if (tradeRows.length === 0) return [];

  const orderIds = tradeRows.map((t) => t.id);
  const fillRows = await db.select().from(fills).where(inArray(fills.orderId, orderIds)).all();
  const fillsByOrder = new Map<string, typeof fillRows>();
  for (const f of fillRows) {
    if (!orderIds.includes(f.orderId)) continue;
    const list = fillsByOrder.get(f.orderId) ?? [];
    list.push(f);
    fillsByOrder.set(f.orderId, list);
  }

  const rows: ExecutionQualityRow[] = [];
  for (const t of tradeRows) {
    const orderFills = fillsByOrder.get(t.id);
    if (!orderFills || orderFills.length === 0) continue; // no real fill evidence - never estimate
    const arrivalPrice = t.arrivalPrice;
    if (!arrivalPrice || !Number.isFinite(arrivalPrice) || arrivalPrice <= 0) continue;
    if (t.side !== 'BUY' && t.side !== 'SELL') continue;
    if (orderFills.some((f) => !Number.isFinite(f.quantity) || f.quantity <= 0 || !Number.isFinite(f.price) || f.price <= 0)) continue;

    const totalQty = orderFills.reduce((sum, f) => sum + f.quantity, 0);
    if (totalQty <= 0) continue;
    const avgFillPrice = orderFills.reduce((sum, f) => sum + f.price * f.quantity, 0) / totalQty;
    const sortedByTime = [...orderFills].sort((a, b) => a.filledAt.localeCompare(b.filledAt));
    const firstFillAt = sortedByTime[0]?.filledAt ?? null;

    const side = t.side as 'BUY' | 'SELL';
    const slippagePerShare = side === 'BUY' ? (avgFillPrice - arrivalPrice) : (arrivalPrice - avgFillPrice);
    const slippageBps = (slippagePerShare / arrivalPrice) * 10000;

    const submissionToFirstFillMs = (t.submittedAt && firstFillAt)
      ? (new Date(firstFillAt).getTime() - new Date(t.submittedAt).getTime())
      : null;

    rows.push({
      orderId: t.id,
      symbol: t.symbol,
      side,
      status: t.status,
      arrivalPrice,
      avgFillPrice,
      filledQuantity: totalQty,
      slippagePerShare,
      slippageBps,
      submittedAt: t.submittedAt,
      firstFillAt,
      submissionToFirstFillMs: (submissionToFirstFillMs !== null && submissionToFirstFillMs >= 0) ? submissionToFirstFillMs : null,
      quantStrategyId: t.quantStrategyId,
      executionEnvironment: t.executionEnvironment,
      evidenceClass: t.evidenceClass,
    });
  }
  return rows;
}

export function summarizeExecutionQuality(allRows: ExecutionQualityRow[], scope: ExecutionEvidenceClass = 'PAPER_ORGANIC'): ExecutionQualitySummary {
  const rows = allRows.filter((row) => row.evidenceClass === scope);
  const attribution = { evidenceClass: scope, excludedRowCount: allRows.length - rows.length };
  if (rows.length === 0) {
    return {
      ...attribution,
      n: 0, meanSlippageBps: null, medianSlippageBps: null, meanSlippagePerShare: null,
      meanSubmissionToFirstFillMs: null, positiveSlippageCount: 0, negativeSlippageCount: 0,
    };
  }
  const bpsValues = rows.map((r) => r.slippageBps).sort((a, b) => a - b);
  const mid = Math.floor(bpsValues.length / 2);
  const medianSlippageBps = bpsValues.length % 2 === 0
    ? (bpsValues[mid - 1] + bpsValues[mid]) / 2
    : bpsValues[mid];
  const latencies = rows.map((r) => r.submissionToFirstFillMs).filter((v): v is number => v !== null);

  return {
    ...attribution,
    n: rows.length,
    meanSlippageBps: bpsValues.reduce((s, v) => s + v, 0) / bpsValues.length,
    medianSlippageBps,
    meanSlippagePerShare: rows.reduce((s, r) => s + r.slippagePerShare, 0) / rows.length,
    meanSubmissionToFirstFillMs: latencies.length > 0 ? latencies.reduce((s, v) => s + v, 0) / latencies.length : null,
    positiveSlippageCount: rows.filter((r) => r.slippagePerShare > 0).length,
    negativeSlippageCount: rows.filter((r) => r.slippagePerShare < 0).length,
  };
}

export function formatExecutionQualityReport(rows: ExecutionQualityRow[], summary: ExecutionQualitySummary): string {
  const lines = [
    'EXECUTION QUALITY / SLIPPAGE (real arrival-price vs real fill-price only)',
    '---------------------------------------------------------------------',
    `Summary scope=${summary.evidenceClass}; excluded rows=${summary.excludedRowCount}. Slippage only; commissions and total costs unknown.`,
    ...EXECUTION_EVIDENCE_CLASSES.map((scope) => {
      const cohort = summarizeExecutionQuality(rows, scope);
      return `${scope}: n=${cohort.n} meanSlippageBps=${cohort.meanSlippageBps?.toFixed(2) ?? 'UNKNOWN'}`;
    }),
  ];
  if (summary.n === 0) {
    lines.push(`NO_DATA - no matching arrival/fill evidence for ${summary.evidenceClass}.`);
  } else {
    lines.push(`n=${summary.n} meanSlippageBps=${summary.meanSlippageBps!.toFixed(2)} medianSlippageBps=${summary.medianSlippageBps!.toFixed(2)}`);
  }
  lines.push(
    summary.meanSubmissionToFirstFillMs !== null ? `meanSubmissionToFirstFillMs=${summary.meanSubmissionToFirstFillMs.toFixed(0)}` : 'meanSubmissionToFirstFillMs=N/A',
    '',
    'Symbol'.padEnd(10) + 'Side'.padEnd(6) + 'Arrival'.padEnd(10) + 'AvgFill'.padEnd(10) + 'SlipBps'.padEnd(10) + 'Strategy'.padEnd(24) + 'Env',
  );
  for (const r of rows.slice(0, 50)) {
    lines.push(
      r.symbol.padEnd(10)
      + r.side.padEnd(6)
      + r.arrivalPrice.toFixed(2).padEnd(10)
      + r.avgFillPrice.toFixed(2).padEnd(10)
      + r.slippageBps.toFixed(2).padEnd(10)
      + (r.quantStrategyId ?? '(none)').padEnd(24)
      + r.evidenceClass,
    );
  }
  return lines.join('\n');
}
