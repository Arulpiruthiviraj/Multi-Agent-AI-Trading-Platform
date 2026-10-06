/**
 * Coverage reconciler (2026-10-06, local-only, Part B workstream H).
 *
 * For EVERY benchmark mover from moverCohort.ts, joins the real evidence already
 * persisted by the pipeline - discovery lineage ledger (observability_events),
 * transaction_traces, risk_assessments, trade_plans / trade_plan_revisions,
 * premarket_focus_reports, premarket_data_reservations, quant_assessments,
 * missed_opportunities, trades/fills - and assigns exactly one primary_fate plus
 * supporting secondary_reasons (JSON).
 *
 * Classification is a funnel-ordered ladder (deepest real stage first, mirroring
 * RiskEngine's "first gate failure is the reported reason" convention): the first
 * stage with positive evidence wins, so a symbol is never double-counted. The
 * ladder is a pure function over an injected CoverageEvidenceStore - the
 * production store reads SQLite; tests inject fakes.
 *
 * NEVER_SEEN cause determination never invents a cause: each cause requires
 * positive evidence, otherwise the cause is UNKNOWN. Three enum values
 * (NEWS_SOURCE_COVERAGE, SYMBOL_EXTRACTION, PREMARKET_REFRESH_TIMING) are
 * recognized but never emitted by the current rules - no honest positive
 * evidence for them exists in current telemetry, and emitting them would be
 * fabrication.
 *
 * Diagnostic only. Never imports RiskEngine/OMS/BrokerManager, never emits
 * TRADE_IDEA_GENERATED, never changes a threshold or gate.
 */
import { sqliteDb } from '../db';
import { continuousIntelligence } from '../config/continuousIntelligence';
import type { MoverCohortMember, MoverScreenConfig } from './moverCohort';
import { defaultScreenConfig } from './moverCohort';

export type PrimaryFate =
  | 'ACTED_ON'
  | 'APPROVED_NOT_EXECUTED'
  | 'CONSENSUS_REJECTED'
  | 'RISK_REJECTED'
  | 'STRATEGY_NO_SETUP'
  | 'EVALUATED'
  | 'SUBSCRIBED_NOT_EVALUATED'
  | 'DISCOVERED_FILTERED'
  | 'DISCOVERED_NOT_PROMOTED'
  | 'NEVER_SEEN'
  | 'INSUFFICIENT_EVIDENCE';

export const PRIMARY_FATES: readonly PrimaryFate[] = [
  'ACTED_ON', 'APPROVED_NOT_EXECUTED', 'CONSENSUS_REJECTED', 'RISK_REJECTED',
  'STRATEGY_NO_SETUP', 'EVALUATED', 'SUBSCRIBED_NOT_EVALUATED', 'DISCOVERED_FILTERED',
  'DISCOVERED_NOT_PROMOTED', 'NEVER_SEEN', 'INSUFFICIENT_EVIDENCE',
];

export type NeverSeenCause =
  | 'UNIVERSE_COVERAGE'
  | 'NEWS_SOURCE_COVERAGE'
  | 'MARKET_MOVER_SOURCE'
  | 'RANK_CAP'
  | 'DATA_UNAVAILABLE'
  | 'SYMBOL_EXTRACTION'
  | 'PREMARKET_REFRESH_TIMING'
  | 'OTHER'
  | 'UNKNOWN';

export interface PremarketKnownBy {
  plan0400: boolean;
  refresh0915: boolean;
  fastLane: boolean;
  discovery: boolean;
}

export interface CoverageVerdict {
  symbol: string;
  primaryFate: PrimaryFate;
  secondaryReasons: string[];
  neverSeenCause: NeverSeenCause | null;
  filterReason: string | null;
  filterPremiseCorrect: boolean | null;
  premarketKnownBy: PremarketKnownBy;
  outcomeWindows: {
    eod: {
      movePct: number | null;
      referencePrice: number | null;
      dayVolumeShares: number | null;
      direction: string;
    };
  };
  referencePrice: number | null;
  eodMovePct: number | null;
}

export interface DiscoveryDecision {
  ts: number;
  admitted: boolean;
  source: string;
  reason: string | null;
  price: number | null;
}

export interface ConsensusTrace {
  lifecycleStatus: string;
  terminalReason: string | null;
  terminalReasonCode: string | null;
}

export interface RiskAssessmentEvidence {
  approved: boolean;
  rejectionGate: string | null;
}

export interface TradePlanEvidence {
  status: string;
  direction: string;
  refreshVersion: number;
}

/** Read-only evidence surface. Production implementation reads SQLite; tests inject fakes. */
export interface CoverageEvidenceStore {
  getDiscoveryDecisions(symbol: string, sinceMs: number, untilMs: number): Promise<DiscoveryDecision[]>;
  getNewsEventCount(symbol: string, sinceMs: number, untilMs: number): Promise<number>;
  getSubscribeCounts(symbol: string, sinceMs: number, untilMs: number): Promise<{ requested: number; acknowledged: number }>;
  getQuantAssessmentCount(symbol: string, sinceIso: string, untilIso: string): Promise<number>;
  getIdeaEventCount(symbol: string, sinceMs: number, untilMs: number): Promise<number>;
  getConsensusTerminalRejected(symbol: string, sinceMs: number, untilMs: number): Promise<{ rejected: boolean; reason: string | null }>;
  getConsensusTraces(symbol: string, sinceIso: string, untilIso: string): Promise<ConsensusTrace[]>;
  getRiskAssessments(symbol: string, sinceIso: string, untilIso: string): Promise<RiskAssessmentEvidence[]>;
  getFillsAndOrders(symbol: string, sinceIso: string, untilIso: string): Promise<{ orders: number; fills: number }>;
  getMissedOpportunity(symbol: string, sinceIso: string, untilIso: string): Promise<{ classification: string } | null>;
  getTradePlans(symbol: string, planDate: string): Promise<TradePlanEvidence[]>;
  getFocusSymbols(planDate: string): Promise<{ primary: string[]; secondary: string[]; watch: string[]; rejected: string[] } | null>;
  getReservationCount(symbol: string, planDate: string): Promise<number>;
  /** True when the market-movers funnel logged at least one discovery decision today. */
  moversFunnelRan(sinceMs: number, untilMs: number): Promise<boolean>;
  getScanTopNPerSide(): number;
}

/**
 * transaction_traces.lifecycleStatus values that can only exist once ChiefTrader
 * consensus has actually been reached for that trace. Same list as
 * MissedOpportunityDetector.ts's CHIEF_APPROVAL_OR_LATER_STATUSES (kept as a
 * local mirror with this comment so a change there is greppable here).
 */
const CHIEF_APPROVAL_OR_LATER_STATUSES = new Set([
  'CONSENSUS_REACHED', 'RISK_APPROVED', 'RISK_REJECTED', 'ORDER_SUBMITTED', 'FILLED', 'CANCELLED',
]);

function windowFor(tradingDate: string): { sinceIso: string; untilIso: string; sinceMs: number; untilMs: number } {
  // Same UTC-midnight window convention as PostMarketAnalysis.generatePostMarketReport.
  const sinceIso = `${tradingDate}T00:00:00.000Z`;
  const sinceMs = Date.parse(sinceIso);
  const untilMs = sinceMs + 86_400_000;
  return { sinceIso, untilIso: new Date(untilMs).toISOString(), sinceMs, untilMs };
}

/**
 * Re-checks a discovery filter's premise against the real EOD evidence. Returns
 * true when the premise held (correct filter), false when the EOD evidence shows
 * the premise was wrong, null when there is no honest way to judge (never guessed).
 */
export function evaluateFilterPremise(
  reason: string | null,
  member: MoverCohortMember,
  cfg: MoverScreenConfig,
): boolean | null {
  if (!reason) return null;
  switch (reason) {
    case 'PRICE':
      // Premise: price below the mandate floor. Re-checked against the prev-close reference.
      if (member.referencePrice == null) return null;
      return member.referencePrice < cfg.minPrice;
    case 'DOLLAR_VOLUME':
    case 'ADV_BELOW_FLOOR': {
      // Premise: genuinely illiquid. Re-checked against the EOD dollar volume.
      if (member.referencePrice == null || member.eodMovePct == null || member.dayVolumeShares == null) return null;
      const eodClose = member.referencePrice * (1 + member.eodMovePct / 100);
      return eodClose * member.dayVolumeShares < cfg.minDollarVolume;
    }
    case 'ADV_DATA_UNAVAILABLE':
    case 'NO_SNAPSHOT_DATA': {
      // Premise: "no data at decision time". If bars exist now, data existed - the
      // fetch failed, not the symbol. If still no data, there is nothing to judge.
      if (member.eodMovePct == null) return null;
      return false;
    }
    case 'SPREAD':
    case 'SPREAD_CROSSED':
      // No EOD spread evidence exists - never guessed.
      return null;
    case 'RANK_CAP':
      if (member.screenerRank == null) return null;
      return member.screenerRank > cfg.scanTopNPerSide;
    default:
      return null;
  }
}

async function determineNeverSeenCause(
  member: MoverCohortMember,
  store: CoverageEvidenceStore,
  sinceMs: number,
  untilMs: number,
  secondary: string[],
): Promise<NeverSeenCause> {
  try {
    if (member.eodMovePct == null) {
      secondary.push('never_seen_cause=DATA_UNAVAILABLE: no daily bars returned for this symbol on the trading date - the benchmark move itself is unmeasurable');
      return 'DATA_UNAVAILABLE';
    }
    if (member.inTradableUniverse === false) {
      secondary.push('never_seen_cause=UNIVERSE_COVERAGE: symbol absent from the Alpaca tradable-assets universe (active, allowed exchanges) - outside the investable universe Argus scans');
      return 'UNIVERSE_COVERAGE';
    }
    const funnelRan = await store.moversFunnelRan(sinceMs, untilMs);
    if (!funnelRan) {
      secondary.push('never_seen_cause=MARKET_MOVER_SOURCE: zero MARKET_MOVER-source discovery decisions logged on the trading date - the movers funnel did not run (disabled or no scan)');
      return 'MARKET_MOVER_SOURCE';
    }
    if (member.beyondScanCap && member.screenerRank != null) {
      const cap = store.getScanTopNPerSide();
      secondary.push(`never_seen_cause=RANK_CAP: screener rank ${member.screenerRank} exceeded the movers scan cap (${cap}) - fetched as a mover but capped out of the scan universe`);
      return 'RANK_CAP';
    }
    secondary.push('never_seen_cause=OTHER: movers funnel ran and the symbol was within the scan cap, but no discovery decision was logged for it - intraday funnel composition differed from the EOD benchmark (movers change through the session)');
    return 'OTHER';
  } catch {
    secondary.push('never_seen_cause=UNKNOWN: cause determination hit a data gap - no cause asserted without evidence');
    return 'UNKNOWN';
  }
}

function baseVerdict(member: MoverCohortMember): Omit<CoverageVerdict, 'primaryFate' | 'secondaryReasons' | 'neverSeenCause' | 'filterReason' | 'filterPremiseCorrect' | 'premarketKnownBy'> {
  return {
    symbol: member.symbol,
    outcomeWindows: {
      eod: {
        movePct: member.eodMovePct,
        referencePrice: member.referencePrice,
        dayVolumeShares: member.dayVolumeShares,
        direction: member.direction,
      },
    },
    referencePrice: member.referencePrice,
    eodMovePct: member.eodMovePct,
  };
}

/**
 * Classifies one benchmark mover. Exactly one primary_fate is always assigned;
 * secondary_reasons carries the supporting evidence strings. Throws only on
 * invalid input - evidence-store failures degrade to INSUFFICIENT_EVIDENCE,
 * never to a fabricated fate.
 */
export async function reconcileMover(
  member: MoverCohortMember,
  tradingDate: string,
  store: CoverageEvidenceStore,
  screenConfig?: MoverScreenConfig,
): Promise<CoverageVerdict> {
  if (!member || !member.symbol) throw new Error('reconcileMover: member with a symbol is required');
  const cfg = screenConfig ?? defaultScreenConfig();
  const { sinceIso, untilIso, sinceMs, untilMs } = windowFor(tradingDate);
  const symbol = member.symbol;
  const base = baseVerdict(member);
  const secondary: string[] = [
    `benchmark move ${member.eodMovePct != null ? `${member.eodMovePct >= 0 ? '+' : ''}${member.eodMovePct.toFixed(2)}%` : 'unknown'} (${member.direction}) vs prev close ${member.referencePrice ?? 'unknown'}`,
  ];

  let ev: {
    decisions: DiscoveryDecision[]; news: number; sub: { requested: number; acknowledged: number };
    quant: number; ideas: number; consensusRejected: { rejected: boolean; reason: string | null };
    traces: ConsensusTrace[]; risks: RiskAssessmentEvidence[]; fillsOrders: { orders: number; fills: number };
    missed: { classification: string } | null; plans: TradePlanEvidence[];
    focus: { primary: string[]; secondary: string[]; watch: string[]; rejected: string[] } | null;
    reservations: number;
  };
  try {
    const [decisions, news, sub, quant, ideas, consensusRejected, traces, risks, fillsOrders, missed, plans, focus, reservations] = await Promise.all([
      store.getDiscoveryDecisions(symbol, sinceMs, untilMs),
      store.getNewsEventCount(symbol, sinceMs, untilMs),
      store.getSubscribeCounts(symbol, sinceMs, untilMs),
      store.getQuantAssessmentCount(symbol, sinceIso, untilIso),
      store.getIdeaEventCount(symbol, sinceMs, untilMs),
      store.getConsensusTerminalRejected(symbol, sinceMs, untilMs),
      store.getConsensusTraces(symbol, sinceIso, untilIso),
      store.getRiskAssessments(symbol, sinceIso, untilIso),
      store.getFillsAndOrders(symbol, sinceIso, untilIso),
      store.getMissedOpportunity(symbol, sinceIso, untilIso),
      store.getTradePlans(symbol, tradingDate),
      store.getFocusSymbols(tradingDate),
      store.getReservationCount(symbol, tradingDate),
    ]);
    ev = { decisions, news, sub, quant, ideas, consensusRejected, traces, risks, fillsOrders, missed, plans, focus, reservations };
  } catch (e) {
    return {
      ...base,
      primaryFate: 'INSUFFICIENT_EVIDENCE',
      secondaryReasons: [...secondary, `evidence store failure: ${e instanceof Error ? e.message : String(e)} - no fate asserted`],
      neverSeenCause: null,
      filterReason: null,
      filterPremiseCorrect: null,
      premarketKnownBy: { plan0400: false, refresh0915: false, fastLane: false, discovery: false },
    };
  }

  const premarketKnownBy: PremarketKnownBy = {
    plan0400: ev.plans.some((p) => p.refreshVersion === 1),
    refresh0915: (ev.focus != null && [ev.focus.primary, ev.focus.secondary, ev.focus.watch].some((tier) => tier.includes(symbol)))
      || ev.plans.some((p) => p.refreshVersion >= 2),
    fastLane: ev.reservations > 0,
    discovery: ev.decisions.some((d) => d.admitted),
  };
  const finish = (
    primaryFate: PrimaryFate,
    extra: string[],
    opts?: { neverSeenCause?: NeverSeenCause | null; filterReason?: string | null; filterPremiseCorrect?: boolean | null },
  ): CoverageVerdict => ({
    ...base,
    primaryFate,
    secondaryReasons: [...secondary, ...extra],
    neverSeenCause: opts?.neverSeenCause ?? null,
    filterReason: opts?.filterReason ?? null,
    filterPremiseCorrect: opts?.filterPremiseCorrect ?? null,
    premarketKnownBy,
  });

  // Funnel-ordered ladder: deepest real stage with positive evidence wins.
  const { orders, fills } = ev.fillsOrders;
  if (fills > 0 || orders > 0) {
    return finish('ACTED_ON', [
      fills > 0 ? `${fills} fill(s) recorded for this symbol in-window` : `${orders} order(s) placed, no fill recorded in-window`,
    ]);
  }

  const consensusApproved = ev.traces.some((t) => CHIEF_APPROVAL_OR_LATER_STATUSES.has(t.lifecycleStatus));
  const riskApproved = ev.risks.some((r) => r.approved);
  const riskRejected = ev.risks.find((r) => !r.approved);
  if (consensusApproved && riskApproved) {
    return finish('APPROVED_NOT_EXECUTED', [
      'consensus approved and RiskEngine approved, but no order was recorded in-window',
      ...(ev.missed ? [`missed_opportunities corroborates: ${ev.missed.classification}`] : []),
    ]);
  }
  if (riskRejected || ev.missed?.classification === 'RISK_REJECTION') {
    return finish('RISK_REJECTED', [
      riskRejected ? `RiskEngine rejected${riskRejected.rejectionGate ? ` at gate '${riskRejected.rejectionGate}'` : ''}` : 'missed_opportunities records RISK_REJECTION',
    ]);
  }
  const consensusRejectedTrace = ev.traces.find((t) => t.lifecycleStatus === 'NO_CONSENSUS');
  if (consensusRejectedTrace || ev.consensusRejected.rejected || ev.missed?.classification === 'CONSENSUS_REJECTION') {
    return finish('CONSENSUS_REJECTED', [
      consensusRejectedTrace
        ? `consensus round ended NO_CONSENSUS${consensusRejectedTrace.terminalReasonCode ? ` (${consensusRejectedTrace.terminalReasonCode})` : ''}`
        : ev.consensusRejected.rejected
          ? `CONSENSUS_TERMINAL_REASON approved=false${ev.consensusRejected.reason ? ` (${ev.consensusRejected.reason})` : ''}`
          : 'missed_opportunities records CONSENSUS_REJECTION',
    ]);
  }
  if (ev.ideas > 0) {
    return finish('EVALUATED', [
      `${ev.ideas} TRADE_IDEA_GENERATED event(s) but no consensus trace was recorded - the idea never reached a recorded consensus decision`,
    ]);
  }
  if (ev.quant > 0) {
    return finish('STRATEGY_NO_SETUP', [
      `${ev.quant} quant assessment(s) recorded, no trade idea emitted - the strategy layer evaluated it and found no setup`,
    ]);
  }
  if (ev.sub.requested > 0 || ev.sub.acknowledged > 0) {
    return finish('SUBSCRIBED_NOT_EVALUATED', [
      `subscription requested x${ev.sub.requested}, acknowledged x${ev.sub.acknowledged}, but zero quant assessments recorded`,
      ...(ev.missed?.classification === 'AGENT_MISS' ? ['missed_opportunities corroborates: AGENT_MISS'] : []),
    ]);
  }
  if (ev.decisions.some((d) => d.admitted)) {
    const sources = [...new Set(ev.decisions.filter((d) => d.admitted).map((d) => d.source))].join('/');
    return finish('DISCOVERED_NOT_PROMOTED', [
      `admitted by discovery (source: ${sources}) but never subscribed in-window`,
      ...(ev.missed?.classification === 'SUBSCRIPTION_MISS' ? ['missed_opportunities corroborates: SUBSCRIPTION_MISS'] : []),
    ]);
  }
  if (ev.decisions.length > 0) {
    const last = ev.decisions[ev.decisions.length - 1];
    const reason = last.reason ?? 'UNKNOWN';
    return finish('DISCOVERED_FILTERED', [
      `filtered at discovery (${reason}, source: ${last.source}) and never admitted afterwards`,
    ], {
      filterReason: reason,
      filterPremiseCorrect: evaluateFilterPremise(reason, member, cfg),
    });
  }
  // Missed-opportunity record without direct discovery lineage (defensive - the
  // detector's own telemetry is real evidence the symbol was seen).
  if (ev.missed) {
    const c = ev.missed.classification;
    if (c === 'SUBSCRIPTION_MISS') return finish('DISCOVERED_NOT_PROMOTED', ['ranked PROMOTE-worthy per missed_opportunities (no direct discovery lineage rows) but never subscribed']);
    if (c === 'AGENT_MISS') return finish('SUBSCRIBED_NOT_EVALUATED', ['missed_opportunities AGENT_MISS (no direct subscription lineage rows) - treated as subscribed but never evaluated']);
    if (c === 'RISK_NOT_CONFIRMED' || c === 'EXECUTION_MISS') {
      return finish('APPROVED_NOT_EXECUTED', [`missed_opportunities ${c}: chief-approved but no fill recorded`]);
    }
    if (c === 'THESIS_INVALIDATED') {
      return finish('EVALUATED', ['premarket thesis invalidated/expired upstream of the live idea pipeline (THESIS_INVALIDATED)']);
    }
  }
  if (ev.plans.length > 0) {
    const latest = ev.plans[ev.plans.length - 1];
    return finish('EVALUATED', [
      `premarket trade plan existed (${latest.direction}, status ${latest.status}, refresh v${latest.refreshVersion}) but no downstream discovery/evaluation evidence was recorded`,
    ]);
  }
  if (ev.focus && [ev.focus.primary, ev.focus.secondary, ev.focus.watch, ev.focus.rejected].some((tier) => tier.includes(symbol))) {
    return finish('EVALUATED', ['named in the premarket focus report but no plan or downstream evaluation evidence was recorded']);
  }
  if (ev.news > 0) {
    // NewsEngine is a discovery source: seen via news, never promoted into the funnel.
    return finish('DISCOVERED_NOT_PROMOTED', [
      `${ev.news} news event(s) analyzed mentioning this symbol, but it never became a discovery candidate`,
    ]);
  }

  // Zero evidence anywhere in the pipeline: the genuine TRUE_UNIVERSE_MISS case.
  const neverSeenCause = await determineNeverSeenCause(member, store, sinceMs, untilMs, secondary);
  return finish('NEVER_SEEN', ['zero discovery-lineage, news, plan, trace, risk, quant, idea, subscription, or fill evidence in-window'], { neverSeenCause });
}

/** Production read-only store over the shared SQLite connection. */
export function createSqliteCoverageEvidenceStore(): CoverageEvidenceStore {
  const parsePayload = (payload: string | null): Record<string, unknown> => {
    try { return JSON.parse(payload ?? '{}') as Record<string, unknown>; } catch { return {}; }
  };
  return {
    async getDiscoveryDecisions(symbol, sinceMs, untilMs) {
      const rows = sqliteDb.prepare(`
        SELECT ts, event_type, payload FROM observability_events
        WHERE symbol = ? AND ts >= ? AND ts < ?
          AND event_type IN ('DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY_CANDIDATE_FILTERED')
        ORDER BY ts ASC
      `).all(symbol, sinceMs, untilMs) as Array<{ ts: number; event_type: string; payload: string | null }>;
      return rows.map((r) => {
        const p = parsePayload(r.payload);
        return {
          ts: r.ts,
          admitted: r.event_type === 'DISCOVERY_CANDIDATE_ADMITTED',
          source: typeof p.source === 'string' ? p.source : 'UNKNOWN',
          reason: typeof p.reason === 'string' ? p.reason : null,
          price: typeof p.price === 'number' ? p.price : null,
        };
      });
    },
    async getNewsEventCount(symbol, sinceMs, untilMs) {
      const row = sqliteDb.prepare(`
        SELECT COUNT(*) c FROM observability_events
        WHERE symbol = ? AND ts >= ? AND ts < ?
          AND event_type IN ('NEWS_ANALYZED', 'NEWS_CLUSTER_CREATED', 'NEWS_CATALYST_STAGED')
      `).get(symbol, sinceMs, untilMs) as { c: number };
      return row.c;
    },
    async getSubscribeCounts(symbol, sinceMs, untilMs) {
      const rows = sqliteDb.prepare(`
        SELECT event_type, COUNT(*) c FROM observability_events
        WHERE symbol = ? AND ts >= ? AND ts < ?
          AND event_type IN ('WATCHLIST_SUBSCRIBE_REQUESTED', 'IBKR_MARKET_DATA_ACKNOWLEDGED')
        GROUP BY event_type
      `).all(symbol, sinceMs, untilMs) as Array<{ event_type: string; c: number }>;
      return {
        requested: rows.find((r) => r.event_type === 'WATCHLIST_SUBSCRIBE_REQUESTED')?.c ?? 0,
        acknowledged: rows.find((r) => r.event_type === 'IBKR_MARKET_DATA_ACKNOWLEDGED')?.c ?? 0,
      };
    },
    async getQuantAssessmentCount(symbol, sinceIso, untilIso) {
      const row = sqliteDb.prepare(`
        SELECT COUNT(*) c FROM quant_assessments WHERE symbol = ? AND created_at >= ? AND created_at < ?
      `).get(symbol, sinceIso, untilIso) as { c: number };
      return row.c;
    },
    async getIdeaEventCount(symbol, sinceMs, untilMs) {
      const row = sqliteDb.prepare(`
        SELECT COUNT(*) c FROM observability_events
        WHERE symbol = ? AND ts >= ? AND ts < ? AND event_type = 'TRADE_IDEA_GENERATED'
      `).get(symbol, sinceMs, untilMs) as { c: number };
      return row.c;
    },
    async getConsensusTerminalRejected(symbol, sinceMs, untilMs) {
      const rows = sqliteDb.prepare(`
        SELECT payload FROM observability_events
        WHERE symbol = ? AND ts >= ? AND ts < ? AND event_type = 'CONSENSUS_TERMINAL_REASON'
        ORDER BY ts DESC LIMIT 5
      `).all(symbol, sinceMs, untilMs) as Array<{ payload: string | null }>;
      for (const r of rows) {
        const p = parsePayload(r.payload);
        if (p.approved === false) {
          const reason = typeof p.terminalReasonCode === 'string' ? p.terminalReasonCode : typeof p.reasonCode === 'string' ? p.reasonCode : null;
          return { rejected: true, reason };
        }
      }
      return { rejected: false, reason: null };
    },
    async getConsensusTraces(symbol, sinceIso, untilIso) {
      return sqliteDb.prepare(`
        SELECT lifecycle_status, terminal_reason, terminal_reason_code FROM transaction_traces
        WHERE symbol = ? AND created_at >= ? AND created_at < ?
        ORDER BY created_at ASC
      `).all(symbol, sinceIso, untilIso) as ConsensusTrace[];
    },
    async getRiskAssessments(symbol, sinceIso, untilIso) {
      const rows = sqliteDb.prepare(`
        SELECT approved, rejection_gate FROM risk_assessments
        WHERE symbol = ? AND created_at >= ? AND created_at < ?
        ORDER BY created_at ASC
      `).all(symbol, sinceIso, untilIso) as Array<{ approved: number; rejection_gate: string | null }>;
      return rows.map((r) => ({ approved: r.approved === 1, rejectionGate: r.rejection_gate }));
    },
    async getFillsAndOrders(symbol, sinceIso, untilIso) {
      const orders = (sqliteDb.prepare(`SELECT COUNT(*) c FROM trades WHERE symbol = ? AND timestamp >= ? AND timestamp < ?`).get(symbol, sinceIso, untilIso) as { c: number }).c;
      const fills = (sqliteDb.prepare(`
        SELECT COUNT(*) c FROM fills
        INNER JOIN trades ON trades.id = fills.order_id
        WHERE trades.symbol = ? AND fills.filled_at >= ? AND fills.filled_at < ?
      `).get(symbol, sinceIso, untilIso) as { c: number }).c;
      return { orders, fills };
    },
    async getMissedOpportunity(symbol, sinceIso, untilIso) {
      const row = sqliteDb.prepare(`
        SELECT classification FROM missed_opportunities
        WHERE symbol = ? AND detected_at >= ? AND detected_at < ?
        ORDER BY detected_at ASC LIMIT 1
      `).get(symbol, sinceIso, untilIso) as { classification: string } | undefined;
      return row ?? null;
    },
    async getTradePlans(symbol, planDate): Promise<TradePlanEvidence[]> {
      const rows = sqliteDb.prepare(`
        SELECT status, direction, refresh_version FROM trade_plans
        WHERE symbol = ? AND plan_date = ?
        ORDER BY created_at ASC
      `).all(symbol, planDate) as Array<{ status: string; direction: string; refresh_version: number }>;
      return rows.map((r) => ({ status: r.status, direction: r.direction, refreshVersion: r.refresh_version ?? 1 }));
    },
    async getFocusSymbols(planDate) {
      const row = sqliteDb.prepare(`
        SELECT primary_json, secondary_json, watch_json, rejected_json FROM premarket_focus_reports
        WHERE plan_date = ? ORDER BY refresh_version DESC LIMIT 1
      `).get(planDate) as { primary_json: string; secondary_json: string; watch_json: string; rejected_json: string } | undefined;
      if (!row) return null;
      const parseTier = (json: string): string[] => {
        try {
          const arr = JSON.parse(json) as Array<{ symbol?: string }>;
          return Array.isArray(arr) ? arr.map((e) => String(e.symbol ?? '').toUpperCase()).filter(Boolean) : [];
        } catch { return []; }
      };
      return {
        primary: parseTier(row.primary_json),
        secondary: parseTier(row.secondary_json),
        watch: parseTier(row.watch_json),
        rejected: parseTier(row.rejected_json),
      };
    },
    async getReservationCount(symbol, planDate) {
      const row = sqliteDb.prepare(`
        SELECT COUNT(*) c FROM premarket_data_reservations
        WHERE symbol = ? AND requested_at >= ? AND requested_at < ?
      `).get(symbol, `${planDate}T00:00:00.000Z`, `${planDate}T23:59:59.999Z`) as { c: number };
      return row.c;
    },
    async moversFunnelRan(sinceMs, untilMs) {
      const row = sqliteDb.prepare(`
        SELECT COUNT(*) c FROM observability_events
        WHERE ts >= ? AND ts < ?
          AND event_type IN ('DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY_CANDIDATE_FILTERED')
          AND json_extract(payload, '$.source') = 'MARKET_MOVER'
      `).get(sinceMs, untilMs) as { c: number };
      return row.c > 0;
    },
    getScanTopNPerSide() {
      // Synchronous config read - mirrors the value buildMoverCohort used.
      return continuousIntelligence.moversTopNPerScan;
    },
  };
}
