/**
 * Trade-level economic attribution (Argus World-Class Open-Source Quant Expansion roadmap,
 * Priority #2, 2026-09-23). For every completed PAPER (or other evidence-class) trade leg: gross
 * P&L, the canonical cost breakdown, a real net-P&L figure with an honest quality label, strategy
 * family, evidence class, and decision-vs-fill timing - the closed-loop record the roadmap's item
 * #3 asked for. Composition only: reuses `executionQuality.ts`'s real rows and
 * `canonicalCostModel.ts`'s real cost classification, never recomputes either.
 *
 * Honest scope limitation, stated explicitly rather than glossed over: Argus prices positions by
 * real broker-reported AVERAGE COST BASIS (`resolvePreTradeEntryPrice()` in OrderManagement.ts),
 * not FIFO/LIFO lot tracking - there is no durable foreign key from a SELL's `trades` row back to
 * the specific BUY row(s) that opened the position, especially for a position built from multiple
 * partial buys. `grossPnl` (trades.profit_loss) is therefore already net of the position's real
 * average entry price, but `netPnlAfterExitLegCostOnly` below nets out ONLY the SELL leg's own
 * slippage+commission - it deliberately does NOT attempt to also subtract the original BUY leg's
 * own execution cost, because there is no reliable, non-heuristic way to attribute it in an
 * average-cost-basis system. Fabricating a FIFO-style entry-cost estimate here would be exactly the
 * "estimated cost presented as observed cost" mistake this whole roadmap item exists to prevent -
 * the field name says precisely what is and is not included, rather than silently claiming a
 * complete round-trip net figure it cannot actually support.
 */
import { buildExecutionQualityReport, type ExecutionQualityRow, type ExecutionEvidenceClass } from './executionQuality';
import { buildTradeCostBreakdown, type TradeCostBreakdown, type CostQuality } from './canonicalCostModel';
import { familyForStrategyId, type QuantFamilyId } from '../quant/strategyFamilies';
import { db } from '../db';
import { quantForecasts } from '../db/schema';
import { and, eq, lte, desc } from 'drizzle-orm';

export interface TradeEconomicAttributionRow {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  evidenceClass: ExecutionEvidenceClass;
  strategyId: string | null;
  strategyFamily: QuantFamilyId | null;
  executionEnvironment: string | null;
  brokerId: string | null;

  cost: TradeCostBreakdown;

  /** trades.profit_loss - real, SELL legs only. Null for BUY legs (no realized P&L yet). */
  grossPnl: number | null;
  /** grossPnl minus this SELL leg's OWN slippage+commission only - see this file's header comment
   *  for the honest scope limitation (does not include the original BUY leg's cost). Null when
   *  grossPnl is null (BUY leg, or SELL leg missing a real gross figure) or when the exit leg's own
   *  cost quality is not MEASURED. */
  netPnlAfterExitLegCostOnly: number | null;
  netPnlQuality: CostQuality;

  decisionTimestamp: string;
  fillTimestamp: string | null;
  submissionToFirstFillMs: number | null;

  // Priority 15 completeness audit (2026-09-23) additive fields - see attributeRow() for
  // real-data provenance of each.
  /** CLAUDE.md's canonical decisionId/correlationId - joinable to getDecisionTrace(traceId). */
  traceId: string | null;
  /** Real deterministic regime label at generation time, joined by traceId from
   *  agent_predictions.regime (see executionQuality.ts's own doc comment) - null when no agent
   *  left one for this traceId. */
  regime: string | null;
  /** Real, exact algebraic re-derivation from already-known values (grossPnl, avgFillPrice,
   *  filledQuantity - all real broker/OMS figures, nothing new estimated): the SELL leg's
   *  proceeds-relative realized return, i.e. grossPnl / (avgFillPrice*qty - grossPnl). Null for
   *  BUY legs, or when grossPnl is null, or when the implied entry value is not positive
   *  (degenerate/zero-cost-basis edge case - never divide into a misleading number). */
  realizedReturnPct: number | null;
  /** Most recent real quant_forecasts row for this symbol/strategy/direction with createdAt at or
   *  before this leg's own decisionTimestamp (no look-ahead) - null when no matching forecast was
   *  ever persisted. Only attempted when strategyId is known; this codebase's forecast key
   *  requires a real strategy/agent grouping, not a guessed one. */
  forecast: {
    forecastId: string;
    modelVersion: string;
    /** BUY | SELL - the forecast's own predicted direction. */
    predictedDirection: string;
    /** True when predictedDirection matches this trade leg's own side - the "predicted vs actual
     *  direction" field. Always defined together with `forecast` (a forecast implies a direction
     *  to compare). */
    directionMatched: boolean;
    netExpectedReturn: number | null;
    costQuality: string | null;
  } | null;
}

/**
 * Real, most-recent, no-look-ahead forecast lookup for one trade leg (Priority 15). Deliberately
 * separate from forecastEngine.ts's own mostRecentForecast() - that function requires a real
 * agentName (e.g. 'QuantEngine', 'TechnicalAgent') which this row does not carry, only
 * strategyId. Only attempted when strategyId is known - a strategy-less forecast lookup would
 * have no honest grouping key to match against.
 */
async function findForecastForLeg(row: ExecutionQualityRow): Promise<TradeEconomicAttributionRow['forecast']> {
  if (!row.quantStrategyId) return null;
  try {
    const rows = await db.select().from(quantForecasts)
      .where(and(
        eq(quantForecasts.symbol, row.symbol),
        eq(quantForecasts.strategyId, row.quantStrategyId),
        lte(quantForecasts.createdAt, row.decisionTimestamp),
      ))
      .orderBy(desc(quantForecasts.createdAt))
      .limit(1)
      .all();
    const f = rows[0];
    if (!f) return null;
    return {
      forecastId: f.forecastId,
      modelVersion: f.modelVersion,
      predictedDirection: f.direction,
      directionMatched: f.direction === row.side,
      netExpectedReturn: f.netExpectedReturn,
      costQuality: f.costQuality,
    };
  } catch (e) {
    console.error(`[tradeEconomicAttribution] Forecast lookup failed for order ${row.orderId} - leaving forecast null (not a fabrication)`, e);
    return null;
  }
}

async function attributeRow(row: ExecutionQualityRow): Promise<TradeEconomicAttributionRow> {
  const cost = buildTradeCostBreakdown(row);

  let netPnlAfterExitLegCostOnly: number | null = null;
  let netPnlQuality: CostQuality = 'UNAVAILABLE';
  if (row.side === 'SELL' && row.grossPnl !== null) {
    netPnlQuality = cost.totalCostQuality;
    if (cost.totalCostQuality === 'MEASURED' && cost.totalCostPerShare !== null) {
      netPnlAfterExitLegCostOnly = row.grossPnl - cost.totalCostPerShare * row.filledQuantity;
    }
  }

  // Exact algebra from already-real numbers (grossPnl is trades.profit_loss, avgFillPrice/
  // filledQuantity are real broker fill data) - never an estimate. entryValue = proceeds -
  // grossPnl; realizedReturnPct = grossPnl / entryValue. Only defined for a SELL leg with a real
  // grossPnl and a positive implied entry value.
  let realizedReturnPct: number | null = null;
  if (row.side === 'SELL' && row.grossPnl !== null && row.avgFillPrice > 0 && row.filledQuantity > 0) {
    const proceeds = row.avgFillPrice * row.filledQuantity;
    const entryValue = proceeds - row.grossPnl;
    if (entryValue > 0) realizedReturnPct = row.grossPnl / entryValue;
  }

  const forecast = await findForecastForLeg(row);

  return {
    orderId: row.orderId,
    symbol: row.symbol,
    side: row.side,
    evidenceClass: row.evidenceClass,
    strategyId: row.quantStrategyId,
    strategyFamily: row.quantStrategyId ? familyForStrategyId(row.quantStrategyId) : null,
    executionEnvironment: row.executionEnvironment,
    brokerId: row.brokerId,
    cost,
    grossPnl: row.grossPnl,
    netPnlAfterExitLegCostOnly,
    netPnlQuality,
    decisionTimestamp: row.decisionTimestamp,
    fillTimestamp: row.firstFillAt,
    submissionToFirstFillMs: row.submissionToFirstFillMs,
    traceId: row.traceId,
    regime: row.regime,
    realizedReturnPct,
    forecast,
  };
}

export async function buildTradeEconomicAttributionReport(limit = 500, scope?: ExecutionEvidenceClass): Promise<TradeEconomicAttributionRow[]> {
  const rows = await buildExecutionQualityReport(limit, scope);
  return Promise.all(rows.map(attributeRow));
}

export interface TradeEconomicAttributionSummary {
  evidenceClass: ExecutionEvidenceClass;
  n: number;
  closedLegsN: number; // SELL legs with a real grossPnl
  netPnlMeasuredN: number; // of those, how many have a real MEASURED net figure
  totalGrossPnl: number | null;
  totalNetPnlMeasuredOnly: number | null; // sum over only the MEASURED-quality subset - never blends in unmeasured legs as zero
  meanTotalCostBps: number | null; // over rows with MEASURED totalCostQuality only
  /** Real count of trade legs (BUY or SELL) whose totalCostQuality is MEASURED - the real sample
   *  size backing meanTotalCostBps. Additive field (roadmap Priority #5) so a caller (forecastEngine.ts)
   *  can gate on a minimum trustworthy sample before ever presenting meanTotalCostBps as evidence. */
  costMeasuredN: number;
}

export function summarizeTradeEconomicAttribution(allRows: TradeEconomicAttributionRow[], scope: ExecutionEvidenceClass): TradeEconomicAttributionSummary {
  const rows = allRows.filter((r) => r.evidenceClass === scope);
  const closed = rows.filter((r) => r.side === 'SELL' && r.grossPnl !== null);
  const measured = closed.filter((r) => r.netPnlQuality === 'MEASURED' && r.netPnlAfterExitLegCostOnly !== null);
  const costMeasured = rows.filter((r) => r.cost.totalCostQuality === 'MEASURED' && r.cost.totalCostBps !== null);

  return {
    evidenceClass: scope,
    n: rows.length,
    closedLegsN: closed.length,
    netPnlMeasuredN: measured.length,
    totalGrossPnl: closed.length > 0 ? closed.reduce((s, r) => s + (r.grossPnl as number), 0) : null,
    totalNetPnlMeasuredOnly: measured.length > 0 ? measured.reduce((s, r) => s + (r.netPnlAfterExitLegCostOnly as number), 0) : null,
    meanTotalCostBps: costMeasured.length > 0 ? costMeasured.reduce((s, r) => s + (r.cost.totalCostBps as number), 0) / costMeasured.length : null,
    costMeasuredN: costMeasured.length,
  };
}

export function formatTradeEconomicAttributionReport(rows: TradeEconomicAttributionRow[], summary: TradeEconomicAttributionSummary): string {
  const lines = [
    'TRADE ECONOMIC ATTRIBUTION (gross/net P&L, real cost quality - see module header for scope limits)',
    '-------------------------------------------------------------------------------------------------',
    `Scope=${summary.evidenceClass}. n=${summary.n}, closedLegs=${summary.closedLegsN}, netPnlMeasured=${summary.netPnlMeasuredN}.`,
    `totalGrossPnl=${summary.totalGrossPnl?.toFixed(2) ?? 'NO_DATA'} totalNetPnl(measuredOnly)=${summary.totalNetPnlMeasuredOnly?.toFixed(2) ?? 'NO_DATA'} meanTotalCostBps=${summary.meanTotalCostBps?.toFixed(2) ?? 'UNAVAILABLE'}`,
    '',
    'Symbol'.padEnd(10) + 'Side'.padEnd(6) + 'GrossPnl'.padEnd(12) + 'NetPnl'.padEnd(12) + 'CostQ'.padEnd(12) + 'Strategy'.padEnd(20) + 'Family',
  ];
  for (const r of rows.slice(0, 50)) {
    lines.push(
      r.symbol.padEnd(10)
      + r.side.padEnd(6)
      + (r.grossPnl !== null ? r.grossPnl.toFixed(2) : '-').padEnd(12)
      + (r.netPnlAfterExitLegCostOnly !== null ? r.netPnlAfterExitLegCostOnly.toFixed(2) : '-').padEnd(12)
      + r.cost.totalCostQuality.padEnd(12)
      + (r.strategyId ?? '(none)').padEnd(20)
      + (r.strategyFamily ?? '-'),
    );
  }
  return lines.join('\n');
}
