/**
 * Extended-hours spread/quote availability report (2026-09-23, operator-directed follow-up to the
 * TSLA gate-25 forensic pass). Read-only composition over already-persisted risk_gate_results rows
 * for gate 'extended_hours_execution_policy' - no new tracking mechanism, no per-tick logging, no
 * RiskEngine/consensus/OMS change of any kind. Exists to answer, going forward: is gate 25 rejecting
 * for a REAL, recurring feed/session limitation (as the 2026-09-23 TSLA forensic found - Alpaca's
 * free IEX feed has no pre/post-market quote book) versus something that looks different later
 * (e.g. after a feed upgrade, or once IBKR is the active quote backend and its bid/ask propagation
 * fix - see MarketDataWorker.ingestIbkrBidAsk - is live). This report never infers a broker/feed
 * per historical row (risk_assessments/risk_gate_results carry no such column - see
 * "knownGaps" below); it reports the CURRENT active quote backend as report-level context only.
 */
import { db } from '../db';
import { riskAssessments, riskGateResults } from '../db/schema';
import { and, eq, gte } from 'drizzle-orm';
import { isReplayTraceId } from '../research/organicPaper';
import { marketDataWorker } from '../services/MarketDataWorker';

const GATE_NAME = 'extended_hours_execution_policy';

export type Gate25Classification =
  | 'NOT_APPLICABLE' // regular session, or extended-hours execution disabled
  | 'PASSED' // real bid+ask, within spread cap, sufficient liquidity, within notional cap
  | 'STALE_QUOTE' // no fresh quote/trade at all
  | 'NO_SPREAD_DATA' // fresh quote/trade exists, but no real ask observed (or ask stale) - the TSLA case
  | 'SPREAD_TOO_WIDE'
  | 'NO_LIQUIDITY_DATA'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'NOTIONAL_CAP'
  | 'BROKER_UNSUPPORTED'
  | 'UNKNOWN'; // detail shape didn't match any known branch - surfaced, never silently dropped

/** Pure classifier over ExtendedHoursExecutionPolicy.ts's own persisted detail shapes - see that
 *  module for the exact shapes this must stay in sync with. */
export function classifyGate25Detail(passed: boolean, detail: Record<string, unknown> | null): Gate25Classification {
  if (!detail) return 'UNKNOWN';
  if (detail.skipped === true) return 'NOT_APPLICABLE';
  if (passed) return 'PASSED';
  if (!('spreadBps' in detail) && 'brokerExtendedHoursCapable' in detail) return 'BROKER_UNSUPPORTED';
  if ('quoteAgeMs' in detail && 'maxQuoteAgeMs' in detail) return 'STALE_QUOTE';
  if ('spreadBps' in detail && detail.spreadBps === null) return 'NO_SPREAD_DATA';
  if ('spreadBps' in detail && 'maxSpreadBps' in detail) return 'SPREAD_TOO_WIDE';
  if ('avgDailyVolumeShares' in detail && detail.avgDailyVolumeShares === null) return 'NO_LIQUIDITY_DATA';
  if ('avgDailyVolumeShares' in detail && 'minAvgDailyVolumeShares' in detail) return 'INSUFFICIENT_LIQUIDITY';
  if ('notionalDollars' in detail && 'maxNotionalDollars' in detail) return 'NOTIONAL_CAP';
  return 'UNKNOWN';
}

export interface ExtendedHoursSpreadReport {
  windowSinceIso: string;
  /** Report-level context only - never attributed retroactively to a historical row (no column
   *  exists for that). See this module's own header. */
  currentQuoteBackend: string;
  totalApplicableEvaluations: number; // excludes NOT_APPLICABLE (regular-session/disabled rows)
  classificationCounts: Record<Gate25Classification, number>;
  /** Of applicable evaluations, the fraction that had ANY fresh quote/trade at all (i.e. did not
   *  classify STALE_QUOTE). Answers "is Argus even receiving data outside RTH for these symbols." */
  quoteAvailabilityRate: number | null;
  /** Of evaluations with a fresh quote (excludes STALE_QUOTE), the fraction that also had a real,
   *  usable ask (PASSED or SPREAD_TOO_WIDE - both require a real spreadBps; NO_SPREAD_DATA does
   *  not). Answers "when we do have data, do we have a two-sided quote." */
  bidAskCompletenessRate: number | null;
  staleQuoteRate: number | null;
  bySymbol: Array<{ symbol: string; classificationCounts: Record<Gate25Classification, number> }>;
  /** Honest, named limitation rather than a silently-omitted dimension - see this module's header. */
  knownGaps: string[];
}

const ALL_CLASSIFICATIONS: Gate25Classification[] = [
  'NOT_APPLICABLE', 'PASSED', 'STALE_QUOTE', 'NO_SPREAD_DATA', 'SPREAD_TOO_WIDE',
  'NO_LIQUIDITY_DATA', 'INSUFFICIENT_LIQUIDITY', 'NOTIONAL_CAP', 'BROKER_UNSUPPORTED', 'UNKNOWN',
];

function emptyCounts(): Record<Gate25Classification, number> {
  const out = {} as Record<Gate25Classification, number>;
  for (const c of ALL_CLASSIFICATIONS) out[c] = 0;
  return out;
}

export async function buildExtendedHoursSpreadReport(sinceIso: string): Promise<ExtendedHoursSpreadReport> {
  const rows = await db.select({
    traceId: riskAssessments.traceId,
    symbol: riskAssessments.symbol,
    passed: riskGateResults.passed,
    detail: riskGateResults.detail,
  })
    .from(riskGateResults)
    .innerJoin(riskAssessments, eq(riskGateResults.traceId, riskAssessments.traceId))
    .where(and(eq(riskGateResults.gateName, GATE_NAME), gte(riskAssessments.createdAt, sinceIso)));

  const organic = rows.filter((r) => !isReplayTraceId(r.traceId));

  const classificationCounts = emptyCounts();
  const bySymbolMap = new Map<string, Record<Gate25Classification, number>>();

  for (const r of organic) {
    let parsed: Record<string, unknown> | null = null;
    try { parsed = r.detail ? JSON.parse(r.detail) : null; } catch { parsed = null; }
    const classification = classifyGate25Detail(r.passed, parsed);
    classificationCounts[classification]++;
    if (!bySymbolMap.has(r.symbol)) bySymbolMap.set(r.symbol, emptyCounts());
    bySymbolMap.get(r.symbol)![classification]++;
  }

  const applicable = ALL_CLASSIFICATIONS
    .filter((c) => c !== 'NOT_APPLICABLE')
    .reduce((sum, c) => sum + classificationCounts[c], 0);

  const staleCount = classificationCounts.STALE_QUOTE;
  const hasQuoteCount = applicable - staleCount;
  const twoSidedCount = classificationCounts.PASSED + classificationCounts.SPREAD_TOO_WIDE;

  return {
    windowSinceIso: sinceIso,
    currentQuoteBackend: marketDataWorker.getQuoteBackend(),
    totalApplicableEvaluations: applicable,
    classificationCounts,
    quoteAvailabilityRate: applicable > 0 ? hasQuoteCount / applicable : null,
    bidAskCompletenessRate: hasQuoteCount > 0 ? twoSidedCount / hasQuoteCount : null,
    staleQuoteRate: applicable > 0 ? staleCount / applicable : null,
    bySymbol: Array.from(bySymbolMap.entries())
      .map(([symbol, classificationCounts]) => ({ symbol, classificationCounts }))
      .sort((a, b) => b.classificationCounts.NO_SPREAD_DATA - a.classificationCounts.NO_SPREAD_DATA),
    knownGaps: [
      'No broker/feed column exists on risk_assessments/risk_gate_results - per-row broker attribution is not retroactively knowable; currentQuoteBackend above is live/report-time only, not per-row.',
      'No session (PRE_MARKET vs AFTER_HOURS) column is persisted in gate 25 detail - this report cannot split PRE_MARKET from AFTER_HOURS without a schema change.',
    ],
  };
}

export function formatExtendedHoursSpreadReport(r: ExtendedHoursSpreadReport): string {
  const pct = (v: number | null) => v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
  const lines = [
    'EXTENDED-HOURS SPREAD / QUOTE AVAILABILITY (gate 25, real non-replay evaluations only)',
    '------------------------------------------------------------------------------------------',
    `Window since:               ${r.windowSinceIso}`,
    `Current quote backend:      ${r.currentQuoteBackend} (report-time only, not attributed per-row)`,
    `Applicable evaluations:     ${r.totalApplicableEvaluations}`,
    `Quote availability rate:    ${pct(r.quoteAvailabilityRate)}  (has any fresh quote/trade - excludes STALE_QUOTE)`,
    `Bid/ask completeness rate:  ${pct(r.bidAskCompletenessRate)}  (of those with a fresh quote, has a real two-sided spread)`,
    `Stale-quote rate:           ${pct(r.staleQuoteRate)}`,
    '',
    'GATE-25 CLASSIFICATION COUNTS',
    '-------------------------------',
    ...Object.entries(r.classificationCounts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c.padEnd(24)}${n}`),
    '',
    'BY SYMBOL (sorted by NO_SPREAD_DATA count, descending)',
    '---------------------------------------------------------',
    ...r.bySymbol.map((s) => {
      const nonZero = Object.entries(s.classificationCounts).filter(([, n]) => n > 0)
        .map(([c, n]) => `${c}=${n}`).join(', ');
      return `${s.symbol.padEnd(8)}${nonZero}`;
    }),
    '',
    'KNOWN GAPS',
    '-----------',
    ...r.knownGaps.map((g) => `- ${g}`),
  ];
  return lines.join('\n');
}
