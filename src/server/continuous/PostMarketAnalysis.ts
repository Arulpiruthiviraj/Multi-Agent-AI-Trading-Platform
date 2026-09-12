/**
 * Postmarket Analysis — Phase 2 (2026-09-10).
 *
 * Real, evidence-grounded daily reconstruction of what the discovery/decision pipeline actually
 * saw and did, reusing existing tables only (observability_events discovery lineage,
 * missed_opportunities, trade_plans, transaction_traces, agent_reasoning_logs, kill_switch_events).
 * Never imports RiskEngine, OMS, or BrokerManager, never emits TRADE_IDEA_GENERATED - diagnostic
 * and observational only, same safety contract as MissedOpportunityDetector.ts.
 *
 * Runs inside the live server process (unlike scripts/postmarket_missed_opportunity_report.ts,
 * which is a standalone read-only script safe to run alongside a live engine) - uses the real
 * shared `db`/`sqliteDb` connection directly, which is correct and safe here since this IS the
 * one process that owns that connection.
 *
 * Explicitly bounded scope (real, not a full research/promotion pipeline - see
 * docs/audits/ARGUS_POSTMARKET_LEARNING_PHASE1_2026-09-10.md for what remains deferred):
 *  - Real per-symbol classification (same taxonomy as the Phase 1 script).
 *  - Real "Would Argus Have Known?" verdict per significant symbol, grounded in the actual
 *    evidence chain (trade_plans / transaction_traces / discovery lineage / news timing) - never
 *    a guess, and explicitly distinct from hindsight ("the stock went up" is not evidence Argus
 *    could have used at the time).
 *  - A real flow-level scorecard (today's actual stage-by-stage counts).
 *  - Real systematic blind-spot detection (aggregate patterns across today's findings only - a
 *    single day is not enough to call anything "recurring"; that requires the multi-day rollup
 *    this module does not yet build).
 *  - Does NOT yet build: per-strategy/per-agent statistical learning (needs real trade outcomes;
 *    today has zero), the trade forensic record (same reason), weekly reviews (needs 5 real
 *    sessions; we have 1), research-hypothesis generation with real historical evidence.
 */
import { db, sqliteDb } from '../db';
import * as schema from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { execSync } from 'child_process';
import { classifyMarketSession } from '../replay/marketSession';
import { logErrorSafely } from '../core/SecretRedaction';

export interface FilteredEvidence {
  source: string; reason: string; price: number | null; dollarVolume: number | null;
  spreadBps: number | null; advShares: number | null; gapMover: boolean; gapPct: number | null;
  rvolMover: boolean; rvol: number | null;
}

export interface SymbolFinding {
  symbol: string;
  firstSeenAtIso: string;
  admitted: boolean;
  filteredReasons: string[];
  hadNewsCoverage: boolean;
  missedOpportunityRow: { classification: string; classificationReason: string } | null;
  classification: string;
  classificationRationale: string;
  priceAtFirstSeen: number | null;
}

export type WouldHaveKnownVerdict =
  | 'YES' | 'PARTIAL' | 'NO' | 'DATA_GAP' | 'UNIVERSE_GAP' | 'SYSTEM_OUTAGE' | 'CORRECT_NON_ACTION' | 'UNKNOWN';

export interface SymbolNarrative {
  symbol: string;
  premarketRadar: boolean;
  argusDirection: string | null;
  argusConfidence: number | null;
  planStatus: string | null;
  thesis: string | null;
  chiefTraderReached: boolean;
  chiefTraderResult: string | null;
  riskEngineReached: boolean;
  newsTimeline: Array<{ atIso: string; eventType: string }>;
  primaryFailureCategory: 'DATA' | 'NEWS' | 'TECHNICAL' | 'QUANT' | 'REGIME' | 'CONSENSUS' | 'RISK' | 'NONE' | 'UNKNOWN';
  wouldArgusHaveKnown: WouldHaveKnownVerdict;
  wouldArgusHaveKnownRationale: string;
}

export interface FlowScorecard {
  discoveryCandidatesAdmitted: number;
  discoveryCandidatesFiltered: number;
  distinctSymbolsEvaluatedByChiefTrader: number;
  consensusRoundsTotal: number;
  consensusApproved: number;
  consensusRejected: number;
  consensusAbandonedMidEvaluation: number;
  quantAssessments: number;
  quantIdeasEmitted: number;
  quantIndependentQualificationAttempts: number;
  riskAssessments: number;
  ordersPlaced: number;
  fills: number;
}

export type RejectedCandidateVerdict = 'CORRECT_REJECTION' | 'POTENTIAL_MISSED_OPPORTUNITY' | 'UNCLEAR' | 'UNCLEAR_NO_PRICE_SNAPSHOT';

export interface RejectedCandidateAudit {
  symbol: string;
  detectedAtIso: string;
  classification: string;
  priceAtDetection: number | null;
  realEodClose: number | null;
  realMovePct: number | null;
  verdict: RejectedCandidateVerdict;
  rationale: string;
}

export interface BlindSpot {
  /** Stable identifier for cross-day aggregation - the human-readable `pattern` text below is
   *  dynamically generated (counts, symbol lists) and not safe to string-match across days. */
  patternKey: string;
  pattern: string;
  affectedSymbolCount: number;
  evidence: string;
}

export interface PostMarketReport {
  tradingDate: string;
  generatedAtIso: string;
  argusCommit: string | null;
  totalSymbolsTouched: number;
  byClassification: Record<string, number>;
  findings: SymbolFinding[];
  narratives: SymbolNarrative[];
  flowScorecard: FlowScorecard;
  blindSpots: BlindSpot[];
  rejectedCandidateAudits: RejectedCandidateAudit[];
}

function classify(f: Pick<SymbolFinding, 'admitted' | 'filteredReasons' | 'hadNewsCoverage' | 'missedOpportunityRow'> & { lastEvidence: FilteredEvidence | null }): { classification: string; rationale: string } {
  if (f.missedOpportunityRow) {
    return { classification: f.missedOpportunityRow.classification, rationale: f.missedOpportunityRow.classificationReason };
  }
  if (!f.admitted && f.filteredReasons.length > 0) {
    const reasons = new Set(f.filteredReasons);
    if (reasons.has('PRICE')) {
      return { classification: 'CORRECT_NON_ACTION', rationale: `Filtered on PRICE (deliberate minimum-price/penny-stock screen) at price ${f.lastEvidence?.price}.` };
    }
    // 2026-09-11: the reason itself now distinguishes these two cases directly
    // (DiscoveryRejectReason's ADV_DATA_UNAVAILABLE vs ADV_BELOW_FLOOR) - previously both
    // collapsed into one 'ADV' reason and this had to infer the distinction indirectly via
    // `advShares == null`. Kept as a fallback for any pre-2026-09-11 persisted row still using the
    // old bare 'ADV' reason (advShares null check), so historical rows classify the same as before.
    if (reasons.has('ADV_DATA_UNAVAILABLE') || (reasons.has('ADV') && f.lastEvidence?.advShares == null)) {
      return { classification: 'DATA_QUALITY_GAP', rationale: 'Filtered on ADV but advShares was null - the gate correctly failed closed on missing data; the data fetch itself is the real gap.' };
    }
    if (reasons.has('ADV_BELOW_FLOOR') || reasons.has('ADV') || reasons.has('DOLLAR_VOLUME')) {
      return { classification: 'LIQUIDITY_EXCLUDED', rationale: `Filtered on ${[...reasons].join('/')} with a real, measured value below the configured floor.` };
    }
    if (reasons.has('SPREAD')) {
      return { classification: 'CORRECT_NON_ACTION', rationale: `Filtered on SPREAD at ${f.lastEvidence?.spreadBps}bps.` };
    }
    return { classification: 'FILTERED_OTHER', rationale: `Filtered for: ${[...reasons].join(', ')}.` };
  }
  if (f.admitted) {
    return { classification: 'ADMITTED_NO_MISSED_OPP_ROW', rationale: 'Admitted as a discovery candidate but never separately surfaced as a missed opportunity - likely evaluated normally.' };
  }
  if (f.hadNewsCoverage) {
    return { classification: 'NEWS_BLIND_SPOT', rationale: 'NewsEngine analyzed a real story mentioning this symbol, but it never became a discovery candidate.' };
  }
  return { classification: 'TRUE_UNIVERSE_MISS', rationale: 'Zero discovery-lineage or news events found for this symbol today.' };
}

function buildFindings(sinceMs: number, sinceIso: string): SymbolFinding[] {
  const discoveryEvents = sqliteDb.prepare(`
    SELECT ts, symbol, event_type, payload
    FROM observability_events
    WHERE ts >= ? AND symbol IS NOT NULL
      AND event_type IN ('DISCOVERY_CANDIDATE_ADMITTED','DISCOVERY_CANDIDATE_FILTERED','NEWS_ANALYZED','NEWS_CLUSTER_CREATED')
    ORDER BY ts ASC
  `).all(sinceMs) as Array<{ ts: number; symbol: string; event_type: string; payload: string | null }>;

  const missedOpps = sqliteDb.prepare(`
    SELECT symbol, classification, classification_reason
    FROM missed_opportunities
    WHERE detected_at >= ?
  `).all(sinceIso) as Array<{ symbol: string; classification: string; classification_reason: string }>;

  const bySymbol = new Map<string, { firstSeenAtMs: number; admitted: boolean; filteredReasons: string[]; firstEvidence: FilteredEvidence | null; lastEvidence: FilteredEvidence | null; hadNewsCoverage: boolean }>();
  for (const ev of discoveryEvents) {
    if (!bySymbol.has(ev.symbol)) {
      bySymbol.set(ev.symbol, { firstSeenAtMs: ev.ts, admitted: false, filteredReasons: [], firstEvidence: null, lastEvidence: null, hadNewsCoverage: false });
    }
    const entry = bySymbol.get(ev.symbol)!;
    if (ev.event_type === 'DISCOVERY_CANDIDATE_ADMITTED') entry.admitted = true;
    if (ev.event_type === 'DISCOVERY_CANDIDATE_FILTERED' && ev.payload) {
      try {
        const parsed = JSON.parse(ev.payload);
        const evidence: FilteredEvidence = parsed.reason ? parsed : parsed.payload;
        if (evidence?.reason) {
          entry.filteredReasons.push(evidence.reason);
          if (!entry.firstEvidence) entry.firstEvidence = evidence;
          entry.lastEvidence = evidence;
        }
      } catch { /* real payload malformed - skip, never fabricate a reason */ }
    }
    if (ev.event_type === 'NEWS_ANALYZED' || ev.event_type === 'NEWS_CLUSTER_CREATED') entry.hadNewsCoverage = true;
  }

  const missedOppBySymbol = new Map<string, { classification: string; classificationReason: string }>();
  for (const m of missedOpps) {
    if (!missedOppBySymbol.has(m.symbol)) missedOppBySymbol.set(m.symbol, { classification: m.classification, classificationReason: m.classification_reason });
  }

  const allSymbols = new Set<string>([...bySymbol.keys(), ...missedOppBySymbol.keys()]);
  const findings: SymbolFinding[] = [];
  for (const symbol of allSymbols) {
    const disc = bySymbol.get(symbol);
    const missedRow = missedOppBySymbol.get(symbol) ?? null;
    const base = {
      admitted: disc?.admitted ?? true,
      filteredReasons: disc?.filteredReasons ?? [],
      hadNewsCoverage: disc?.hadNewsCoverage ?? false,
      missedOpportunityRow: missedRow,
      lastEvidence: disc?.lastEvidence ?? null,
    };
    const { classification, rationale } = classify(base);
    findings.push({
      symbol,
      firstSeenAtIso: disc ? new Date(disc.firstSeenAtMs).toISOString() : sinceIso,
      admitted: base.admitted,
      filteredReasons: base.filteredReasons,
      hadNewsCoverage: base.hadNewsCoverage,
      missedOpportunityRow: missedRow,
      classification,
      classificationRationale: rationale,
      priceAtFirstSeen: disc?.firstEvidence?.price ?? null,
    });
  }
  return findings;
}

function buildFlowScorecard(sinceMs: number, sinceIso: string): FlowScorecard {
  const discAdmitted = (sqliteDb.prepare(`SELECT COUNT(*) c FROM observability_events WHERE ts >= ? AND event_type='DISCOVERY_CANDIDATE_ADMITTED'`).get(sinceMs) as any).c;
  const discFiltered = (sqliteDb.prepare(`SELECT COUNT(*) c FROM observability_events WHERE ts >= ? AND event_type='DISCOVERY_CANDIDATE_FILTERED'`).get(sinceMs) as any).c;
  const distinctSymbols = (sqliteDb.prepare(`SELECT COUNT(DISTINCT symbol) c FROM transaction_traces WHERE created_at >= ?`).get(sinceIso) as any).c;
  const statusRows = sqliteDb.prepare(`SELECT lifecycle_status, COUNT(*) c FROM transaction_traces WHERE created_at >= ? GROUP BY lifecycle_status`).all(sinceIso) as Array<{ lifecycle_status: string; c: number }>;
  let approved = 0, rejected = 0, abandoned = 0, total = 0;
  for (const r of statusRows) {
    total += r.c;
    if (r.lifecycle_status === 'ANALYZING') abandoned += r.c;
    else if (r.lifecycle_status === 'NO_CONSENSUS') rejected += r.c;
    else approved += r.c;
  }
  const quantAssessments = (sqliteDb.prepare(`SELECT COUNT(*) c FROM quant_assessments WHERE created_at >= ?`).get(sinceIso) as any).c;
  const quantIdeas = (sqliteDb.prepare(`SELECT COUNT(*) c FROM quant_assessments WHERE created_at >= ? AND emitted_trade_idea=1`).get(sinceIso) as any).c;
  const quantIndependentAttempts = (sqliteDb.prepare(`SELECT COUNT(*) c FROM agent_reasoning_logs WHERE timestamp >= ? AND reasoning_summary LIKE '%QUANT_INDEPENDENT%'`).get(sinceIso) as any).c;
  const riskAssessments = (sqliteDb.prepare(`SELECT COUNT(*) c FROM risk_assessments WHERE created_at >= ?`).get(sinceIso) as any).c;
  const orders = (sqliteDb.prepare(`SELECT COUNT(*) c FROM trades WHERE timestamp >= ?`).get(sinceIso) as any).c;
  const fills = (sqliteDb.prepare(`SELECT COUNT(*) c FROM fills WHERE filled_at >= ?`).get(sinceIso) as any).c;

  return {
    discoveryCandidatesAdmitted: discAdmitted,
    discoveryCandidatesFiltered: discFiltered,
    distinctSymbolsEvaluatedByChiefTrader: distinctSymbols,
    consensusRoundsTotal: total,
    consensusApproved: approved,
    consensusRejected: rejected,
    consensusAbandonedMidEvaluation: abandoned,
    quantAssessments,
    quantIdeasEmitted: quantIdeas,
    quantIndependentQualificationAttempts: quantIndependentAttempts,
    riskAssessments,
    ordersPlaced: orders,
    fills,
  };
}

function detectBlindSpots(findings: SymbolFinding[]): BlindSpot[] {
  const spots: BlindSpot[] = [];
  const dataGapSymbols = findings.filter((f) => f.classification === 'DATA_QUALITY_GAP');
  if (dataGapSymbols.length >= 3) {
    spots.push({
      patternKey: 'NULL_ADV_LIQUIDITY_GATE',
      pattern: 'A material share of liquidity-filtered symbols today were excluded on missing (null) ADV data, not a genuine measured low-liquidity value - the gate is failing closed correctly, but the underlying data fetch is the real gap.',
      affectedSymbolCount: dataGapSymbols.length,
      evidence: dataGapSymbols.slice(0, 10).map((f) => f.symbol).join(', '),
    });
  }
  const newsBlindSpots = findings.filter((f) => f.classification === 'NEWS_BLIND_SPOT');
  if (newsBlindSpots.length >= 1) {
    spots.push({
      patternKey: 'NEWS_TO_DISCOVERY_GAP',
      pattern: 'NewsEngine analyzed real stories for these symbols, but none became discovery candidates - a real gap between news detection and discovery admission (news-catalyst discovery is a new, off-by-default source added 2026-09-10 that would address this once enabled).',
      affectedSymbolCount: newsBlindSpots.length,
      evidence: newsBlindSpots.slice(0, 10).map((f) => f.symbol).join(', '),
    });
  }
  return spots;
}

async function buildNarrative(symbol: string, sinceIso: string, sinceMs: number): Promise<SymbolNarrative> {
  const plan = sqliteDb.prepare(`
    SELECT direction, confidence, status, thesis FROM trade_plans
    WHERE symbol = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1
  `).get(symbol, sinceIso) as { direction: string; confidence: number; status: string; thesis: string } | undefined;

  const traces = sqliteDb.prepare(`
    SELECT lifecycle_status, terminal_reason FROM transaction_traces
    WHERE symbol = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1
  `).get(symbol, sinceIso) as { lifecycle_status: string; terminal_reason: string | null } | undefined;

  const riskCount = (sqliteDb.prepare(`SELECT COUNT(*) c FROM risk_assessments WHERE symbol = ? AND created_at >= ?`).get(symbol, sinceIso) as any).c;

  const newsEvents = sqliteDb.prepare(`
    SELECT ts, event_type FROM observability_events
    WHERE symbol = ? AND ts >= ? AND event_type IN ('NEWS_CATALYST_STAGED','NEWS_IDEA_DISCARDED_NO_FRESH_DATA','NEWS_ANALYZED','NEWS_CLUSTER_CREATED')
    ORDER BY ts ASC
  `).all(symbol, sinceMs) as Array<{ ts: number; event_type: string }>;

  const hadDiscard = newsEvents.some((e) => e.event_type === 'NEWS_IDEA_DISCARDED_NO_FRESH_DATA');
  const hadCatalyst = newsEvents.some((e) => e.event_type === 'NEWS_CATALYST_STAGED' || e.event_type === 'NEWS_ANALYZED');

  let primaryFailureCategory: SymbolNarrative['primaryFailureCategory'] = 'UNKNOWN';
  let wouldArgusHaveKnown: WouldHaveKnownVerdict = 'UNKNOWN';
  let rationale = 'Insufficient evidence to classify.';

  if (traces && traces.lifecycle_status !== 'ANALYZING') {
    primaryFailureCategory = 'CONSENSUS';
    wouldArgusHaveKnown = 'PARTIAL';
    rationale = `ChiefTrader evaluated this symbol and reached a real terminal decision (${traces.terminal_reason ?? traces.lifecycle_status}) - the information reached the decision layer but did not clear the consensus bar.`;
  } else if (hadDiscard) {
    primaryFailureCategory = 'DATA';
    wouldArgusHaveKnown = 'DATA_GAP';
    rationale = 'A real, catalyst-backed idea was generated but discarded because no fresh market-data tick arrived within the required window before it could reach ChiefTrader - a data-freshness gate, not a directional judgment.';
  } else if (plan) {
    primaryFailureCategory = plan.direction === 'HOLD' ? 'REGIME' : 'CONSENSUS';
    wouldArgusHaveKnown = 'PARTIAL';
    rationale = `A premarket TradePlan existed (${plan.direction} at ${(plan.confidence * 100).toFixed(0)}% confidence, now ${plan.status}) based on the real evidence available at plan-creation time. ${hadCatalyst ? 'A real news catalyst appeared later in the session that this plan predates.' : 'No later news catalyst was found for this symbol today.'}`;
  } else {
    wouldArgusHaveKnown = 'UNKNOWN';
    rationale = 'No trade plan, no consensus round, no discarded idea found for this symbol - insufficient evidence to reconstruct a decision point.';
  }

  return {
    symbol,
    premarketRadar: !!plan,
    argusDirection: plan?.direction ?? null,
    argusConfidence: plan?.confidence ?? null,
    planStatus: plan?.status ?? null,
    thesis: plan?.thesis ?? null,
    chiefTraderReached: !!traces,
    chiefTraderResult: traces ? (traces.terminal_reason ?? traces.lifecycle_status) : null,
    riskEngineReached: riskCount > 0,
    newsTimeline: newsEvents.map((e) => ({ atIso: new Date(e.ts).toISOString(), eventType: e.event_type })),
    primaryFailureCategory,
    wouldArgusHaveKnown,
    wouldArgusHaveKnownRationale: rationale,
  };
}

function getArgusCommit(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim();
  } catch {
    return null;
  }
}

/** Read-only, never persisted (this module runs in-process and could safely write via
 *  historicalDataGateway, but a lightweight direct fetch keeps this audit independent of that
 *  module's own cache/rate-limit state - consistent with the Phase 1 script's identical pattern).
 *  Returns null, never a fabricated price, when Alpaca has nothing for this symbol/date. */
async function fetchRealEodBar(symbol: string, dateIso: string): Promise<{ close: number } | null> {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return null;
  try {
    const start = `${dateIso}T00:00:00Z`;
    const end = `${dateIso}T23:59:59Z`;
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=5&adjustment=raw&feed=iex`;
    const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY } });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const bars = data.bars || [];
    if (bars.length === 0) return null;
    return { close: bars[bars.length - 1].c };
  } catch {
    return null;
  }
}

/**
 * Trade-to-Learning Feedback Loop request, §16/§17 ("learn from safe non-trades too" / audit
 * every rejected candidate, not just committed trades). Real data source: missed_opportunities
 * rows already classified CONSENSUS_REJECTION by the existing MissedOpportunityDetector (which
 * itself only flags real, PROMOTE-worthy, bullish-ranked candidates - so a rejected row here is
 * always a real candidate ChiefTrader actually declined, never a fabricated one). Deduped to the
 * first (earliest) rejection per symbol per day.
 *
 * Deliberately does NOT attempt this for the broader ~1,292 raw ChiefTrader NO_CONSENSUS rows -
 * transaction_traces has no stored side/price-at-decision, so there is no honest way to know
 * which direction was rejected or what price to compare against without fabricating one.
 * missed_opportunities is the one real source that stores both.
 */
async function auditRejectedCandidates(sinceIso: string): Promise<RejectedCandidateAudit[]> {
  const rows = sqliteDb.prepare(`
    SELECT symbol, detected_at, classification, classification_reason, price_at_detection
    FROM missed_opportunities
    WHERE detected_at >= ? AND classification = 'CONSENSUS_REJECTION'
    ORDER BY detected_at ASC
  `).all(sinceIso) as Array<{ symbol: string; detected_at: string; classification: string; classification_reason: string; price_at_detection: number | null }>;

  const seen = new Set<string>();
  const audits: RejectedCandidateAudit[] = [];
  for (const r of rows) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    const dateOnly = r.detected_at.slice(0, 10);

    let realEodClose: number | null = null;
    let realMovePct: number | null = null;
    let verdict: RejectedCandidateVerdict = 'UNCLEAR_NO_PRICE_SNAPSHOT';
    let rationale = 'No price-at-detection snapshot was stored for this rejection - cannot honestly compute a real subsequent move.';

    if (r.price_at_detection != null) {
      const bar = await fetchRealEodBar(r.symbol, dateOnly);
      realEodClose = bar?.close ?? null;
      if (realEodClose != null) {
        realMovePct = ((realEodClose - r.price_at_detection) / r.price_at_detection) * 100;
        if (Math.abs(realMovePct) < 2) {
          verdict = 'UNCLEAR';
          rationale = `Real subsequent move was small (${realMovePct.toFixed(1)}%) - not enough signal to call the rejection right or wrong either way.`;
        } else if (realMovePct >= 2) {
          verdict = 'POTENTIAL_MISSED_OPPORTUNITY';
          rationale = `Real subsequent move was +${realMovePct.toFixed(1)}% - favorable to the rejected (bullish) candidate. This does NOT mean the rejection was wrong - the 75% consensus bar reflects each agent's real calibrated accuracy, not hindsight. Flagged as a research candidate only, never a signal to loosen the bar.`;
        } else {
          verdict = 'CORRECT_REJECTION';
          rationale = `Real subsequent move was ${realMovePct.toFixed(1)}% - unfavorable to the rejected candidate. The rejection held up.`;
        }
      } else {
        rationale = 'Price-at-detection was real, but a real EOD close could not be fetched (no Alpaca data for this symbol/date) - cannot honestly compute a real move.';
      }
    }

    audits.push({
      symbol: r.symbol,
      detectedAtIso: r.detected_at,
      classification: r.classification,
      priceAtDetection: r.price_at_detection,
      realEodClose,
      realMovePct,
      verdict,
      rationale,
    });
  }
  return audits;
}

/** Real, bounded report generation for one trading date. Idempotent per date via the caller's
 *  own persist step (upsert on the unique trading_date column). */
export async function generatePostMarketReport(tradingDate: string): Promise<PostMarketReport> {
  const sinceIso = `${tradingDate}T00:00:00.000Z`;
  const sinceMs = new Date(sinceIso).getTime();

  const findings = buildFindings(sinceMs, sinceIso);
  const flowScorecard = buildFlowScorecard(sinceMs, sinceIso);
  const blindSpots = detectBlindSpots(findings);

  // Narratives are built only for symbols with real, traceable evidence beyond a bare discovery
  // filter (a premarket plan, a missed-opportunity row, or a news-discard event) - a symbol with
  // only a plain liquidity/price filter has nothing further to reconstruct.
  const narrativeworthy = findings.filter((f) => f.missedOpportunityRow || f.classification === 'ADMITTED_NO_MISSED_OPP_ROW' || f.classification === 'NEWS_BLIND_SPOT');
  const narratives: SymbolNarrative[] = [];
  for (const f of narrativeworthy.slice(0, 50)) {
    narratives.push(await buildNarrative(f.symbol, sinceIso, sinceMs));
  }

  const byClassification = findings.reduce((acc, f) => { acc[f.classification] = (acc[f.classification] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  const rejectedCandidateAudits = await auditRejectedCandidates(sinceIso);

  return {
    tradingDate,
    generatedAtIso: new Date().toISOString(),
    argusCommit: getArgusCommit(),
    totalSymbolsTouched: findings.length,
    byClassification,
    findings,
    narratives,
    flowScorecard,
    blindSpots,
    rejectedCandidateAudits,
  };
}

/** Persists (upserts) a report under its trading_date. Safe to call multiple times for the same
 *  date - a later call overwrites the earlier one rather than creating a duplicate row. */
export async function persistPostMarketReport(report: PostMarketReport): Promise<void> {
  await db.insert(schema.postmarketReports).values({
    id: report.tradingDate,
    tradingDate: report.tradingDate,
    generatedAt: report.generatedAtIso,
    argusCommit: report.argusCommit,
    totalSymbolsTouched: report.totalSymbolsTouched,
    byClassificationJson: JSON.stringify(report.byClassification),
    findingsJson: JSON.stringify({ findings: report.findings, narratives: report.narratives, flowScorecard: report.flowScorecard, blindSpots: report.blindSpots, rejectedCandidateAudits: report.rejectedCandidateAudits }),
    status: 'COMPLETED',
    errorMessage: null,
  }).onConflictDoUpdate({
    target: schema.postmarketReports.tradingDate,
    set: {
      generatedAt: report.generatedAtIso,
      argusCommit: report.argusCommit,
      totalSymbolsTouched: report.totalSymbolsTouched,
      byClassificationJson: JSON.stringify(report.byClassification),
      findingsJson: JSON.stringify({ findings: report.findings, narratives: report.narratives, flowScorecard: report.flowScorecard, blindSpots: report.blindSpots, rejectedCandidateAudits: report.rejectedCandidateAudits }),
      status: 'COMPLETED',
      errorMessage: null,
    },
  });
}

export async function getPostMarketReport(tradingDate: string): Promise<PostMarketReport | null> {
  const rows = await db.select().from(schema.postmarketReports).where(eq(schema.postmarketReports.tradingDate, tradingDate));
  const row = rows[0];
  if (!row) return null;
  const parsed = JSON.parse(row.findingsJson);
  return {
    tradingDate: row.tradingDate,
    generatedAtIso: row.generatedAt,
    argusCommit: row.argusCommit,
    totalSymbolsTouched: row.totalSymbolsTouched,
    byClassification: JSON.parse(row.byClassificationJson),
    findings: parsed.findings,
    narratives: parsed.narratives,
    flowScorecard: parsed.flowScorecard,
    blindSpots: parsed.blindSpots,
    rejectedCandidateAudits: parsed.rejectedCandidateAudits ?? [],
  };
}

export interface RecurringBlindSpot {
  patternKey: string;
  examplePattern: string;
  daysAffected: number;
  totalDaysConsidered: number;
  totalSymbolCount: number;
  exampleEvidence: string[];
}

export interface RejectedCandidateRollupStats {
  totalAudited: number;
  correctRejections: number;
  potentialMissedOpportunities: number;
  unclear: number;
  noPriceSnapshot: number;
}

export interface MultiDayRollup {
  daysConsidered: string[];
  totalReportsFound: number;
  aggregateByClassification: Record<string, number>;
  recurringBlindSpots: RecurringBlindSpot[];
  rejectedCandidateStats: RejectedCandidateRollupStats;
}

/**
 * Trade-to-Learning Feedback Loop request §9/§21 ("detect systematic blind spots... over
 * sufficient samples, not a single day's pattern-matching") - real, honest multi-day rollup.
 * Explicitly does NOT claim a pattern is "recurring" from a single day - a patternKey must
 * appear in at least 2 of the available reports to be included. Gracefully degrades to however
 * many real reports actually exist (as few as 0 or 1) rather than requiring a fixed history
 * depth - callers should treat a rollup built from 1-2 days as preliminary, matching this
 * codebase's own established caution about small-sample claims (see e.g. the Phase 2 Quant-Core
 * parity checkpoint's own "real data, honestly small" framing).
 */
export async function computeMultiDayRollup(maxDays: number): Promise<MultiDayRollup> {
  const rows = await db.select().from(schema.postmarketReports)
    .orderBy(desc(schema.postmarketReports.tradingDate))
    .limit(maxDays);

  const daysConsidered = rows.map((r) => r.tradingDate);
  const aggregateByClassification: Record<string, number> = {};
  const blindSpotAgg = new Map<string, { examplePattern: string; days: Set<string>; totalSymbolCount: number; exampleEvidence: string[] }>();
  const rejectedStats: RejectedCandidateRollupStats = { totalAudited: 0, correctRejections: 0, potentialMissedOpportunities: 0, unclear: 0, noPriceSnapshot: 0 };

  for (const row of rows) {
    const byClass = JSON.parse(row.byClassificationJson) as Record<string, number>;
    for (const [k, v] of Object.entries(byClass)) aggregateByClassification[k] = (aggregateByClassification[k] ?? 0) + v;

    const parsed = JSON.parse(row.findingsJson);
    const blindSpots: BlindSpot[] = parsed.blindSpots ?? [];
    for (const spot of blindSpots) {
      if (!blindSpotAgg.has(spot.patternKey)) {
        blindSpotAgg.set(spot.patternKey, { examplePattern: spot.pattern, days: new Set(), totalSymbolCount: 0, exampleEvidence: [] });
      }
      const agg = blindSpotAgg.get(spot.patternKey)!;
      agg.days.add(row.tradingDate);
      agg.totalSymbolCount += spot.affectedSymbolCount;
      if (agg.exampleEvidence.length < 5) agg.exampleEvidence.push(spot.evidence);
    }

    const audits: RejectedCandidateAudit[] = parsed.rejectedCandidateAudits ?? [];
    for (const a of audits) {
      rejectedStats.totalAudited += 1;
      if (a.verdict === 'CORRECT_REJECTION') rejectedStats.correctRejections += 1;
      else if (a.verdict === 'POTENTIAL_MISSED_OPPORTUNITY') rejectedStats.potentialMissedOpportunities += 1;
      else if (a.verdict === 'UNCLEAR') rejectedStats.unclear += 1;
      else rejectedStats.noPriceSnapshot += 1;
    }
  }

  const recurringBlindSpots: RecurringBlindSpot[] = [...blindSpotAgg.entries()]
    .filter(([, agg]) => agg.days.size >= 2)
    .map(([patternKey, agg]) => ({
      patternKey,
      examplePattern: agg.examplePattern,
      daysAffected: agg.days.size,
      totalDaysConsidered: daysConsidered.length,
      totalSymbolCount: agg.totalSymbolCount,
      exampleEvidence: agg.exampleEvidence,
    }));

  return {
    daysConsidered,
    totalReportsFound: rows.length,
    aggregateByClassification,
    recurringBlindSpots,
    rejectedCandidateStats: rejectedStats,
  };
}

function tradingDateInTimeZone(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

/**
 * Real, modest scheduler: checks once per tick whether today's real regular session has ended
 * (classifyMarketSession() !== REGULAR/PRE_MARKET, i.e. AFTER_HOURS or CLOSED) and, if so, runs
 * the report exactly once for that date - dedup is the real postmarket_reports.trading_date
 * unique column via persistPostMarketReport()'s upsert, so a restart mid-run safely regenerates
 * rather than silently skipping or duplicating. Never runs more than once per tick; a failure
 * logs and is retried on the next tick rather than crashing the process.
 */
export class PostMarketAnalysisWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private inFlight = false;

  start(intervalMs = 30 * 60_000): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => { void this.tick(); }, intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.inFlight) return;
    const session = classifyMarketSession(now.getTime(), 'America/New_York', true);
    if (session === 'REGULAR' || session === 'PRE_MARKET') return;
    const tradingDate = tradingDateInTimeZone(now.getTime(), 'America/New_York');

    this.inFlight = true;
    try {
      const existing = await db.select().from(schema.postmarketReports).where(eq(schema.postmarketReports.tradingDate, tradingDate));
      if (existing[0]?.status === 'COMPLETED') return;
      const report = await generatePostMarketReport(tradingDate);
      await persistPostMarketReport(report);
    } catch (e) {
      logErrorSafely('[PostMarketAnalysisWorker] report generation failed - will retry next tick', e);
    } finally {
      this.inFlight = false;
    }
  }
}

export const postMarketAnalysisWorker = new PostMarketAnalysisWorker();
