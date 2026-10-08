/**
 * Phase 9 (2026-08-31) - "why-no-trade" single-candidate explainer. Reuses the same real
 * CONSENSUS_TERMINAL_REASON rows consensusPipelineReport.ts aggregates, but for ONE symbol (or
 * the most recent evaluation of any symbol) joins the downstream risk_assessments/risk_gate_results
 * rows by traceId so a single candidate's full chain - agent votes, independence, consensus,
 * RiskEngine gate outcome - is answerable in one call. Never a new evaluation path; purely reads
 * what the real pipeline already persisted.
 *
 * 2026-10-07 (Part 42 observability fix): the quant-first branch never persists a
 * CONSENSUS_TERMINAL_REASON row for quant-path outcomes, so this report also reads the
 * quant-path terminal events:
 *   - observability_events eventType QUANT_POLICY_APPROVED / QUANT_POLICY_REJECTED (indexed;
 *     emitted by ChiefTraderAgent's quant_policy_evaluated structured-log), and
 *   - trade_lifecycle_transitions evidence for QUANT_NOT_AUTHORIZED (that terminal rejection is
 *     emitted as an EventBus DESK_NO_TRADE event only - no observability_events emitter exists;
 *     ChiefTraderAgent.ts is intentionally untouched here, so the report reads the lifecycle
 *     store instead, bounded window, see findQuantNotAuthorized).
 * When NO terminal evaluation exists at all, the report leads with live global state
 * (tradingState / Autobot / broker readiness / market-data line counts) instead of a bare
 * "not found" - TRADING_PAUSED is the most common real reason nothing traded.
 *
 * Part 42 "WHY HAS NOTHING TRADED?" taxonomy mapping (15 categories). This report is read-only:
 * it only RELABELS outcomes the pipeline already persisted. It never invents a category for
 * which no emitter exists.
 *
 * Covered (backed by a real emitter/store):
 *   TRADING_PAUSED       <- tradingEngine.state.tradingState (TRADING_PAUSED / EMERGENCY_STOP).
 *                           Checked FIRST: nothing can trade while paused even if an evaluation
 *                           row exists, and even when NO evaluation row exists at all.
 *   QUANT_POLICY_REJECTED <- observability_events eventType QUANT_POLICY_REJECTED
 *                           (ChiefTraderAgent quant_policy_evaluated structured-log).
 *   QUANT_NOT_AUTHORIZED <- trade_lifecycle_transitions evidence.terminalReasonCode on the
 *                           DESK_NO_TRADE event (ChiefTraderAgent.emitQuantStrategyNotEligible).
 *   CONSENSUS_INSUFFICIENT <- CONSENSUS_TERMINAL_REASON codes that all mean "consensus said no":
 *                           AGENT_HOLD, AGENT_DATA_UNAVAILABLE, CONFIDENCE_BELOW_STRONG,
 *                           INSUFFICIENT_AGENT_PARTICIPATION, HARD_VETO, MODERATE_REJECT_*.
 *   RISK_REJECTED        <- risk_assessments.rejectionGate for the trace (existing join).
 *   BROKER_UNAVAILABLE   <- argusRuntime.brokerReadiness().ready === false.
 *   SUBSCRIPTION_STARVED / DATA_NOT_READY <- market-data line summary COUNTS only in the global
 *                           block; per-symbol drill-down lives in `argus market-data-diagnostics
 *                           --symbols=SYM` and `argus discovery-lineage --symbol=SYM` (linked,
 *                           never duplicated here).
 * Gaps (no code emitted anywhere in the codebase as of 2026-10-07 - never fabricated here):
 *   NO_VALID_SETUP, NOT_DISCOVERED, REGIME_NOT_ELIGIBLE, STRATEGY_TRIGGER_FAILED, EV_FAILED,
 *   RR_FAILED, AI_UNAVAILABLE_OPTIONAL.
 *   (The quant payload's reasonCode/checks carry finer policy detail than QUANT_POLICY_REJECTED
 *   alone; AI availability shows up as the quant payload's aiAvailability field, never as a
 *   terminal code.)
 */
import { db } from '../db';
import { observabilityEvents, riskAssessments, riskGateResults, tradeLifecycleTransitions } from '../db/schema';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { getCandidate } from '../continuous/candidateLifecycle';

export type QuantTerminalEventType = 'QUANT_POLICY_APPROVED' | 'QUANT_POLICY_REJECTED' | 'QUANT_NOT_AUTHORIZED';

const QUANT_POLICY_EVENT_TYPES: readonly string[] = ['QUANT_POLICY_APPROVED', 'QUANT_POLICY_REJECTED'];

/** Bounded read window for the unindexed-by-code trade_lifecycle_transitions scan (createdAt is
 * indexed; the 200 most recent transitions are always cheap to read, then filtered in memory).
 * QUANT_NOT_AUTHORIZED rejections are terminal and recent by construction, so a stale miss outside
 * this window would already be superseded by newer pipeline evidence anyway. */
const RECENT_LIFECYCLE_WINDOW = 200;

export interface QuantCheckResult {
  id: string;
  category: string;
  passed: boolean;
  detail: string | null;
}

export interface QuantPathOutcome {
  found: boolean;
  /** Epoch-ms of the underlying row (observability ts, or lifecycle createdAt). */
  tsMs: number | null;
  eventType: QuantTerminalEventType | null;
  symbol: string | null;
  traceId: string | null;
  side: string | null;
  /** null for QUANT_NOT_AUTHORIZED - the policy never evaluated the idea. */
  approved: boolean | null;
  decisionPolicy: string | null;
  /** Policy-level reason code (or the authorization failure reason for QUANT_NOT_AUTHORIZED). */
  reasonCode: string | null;
  reason: string | null;
  strategyId: string | null;
  strategyLifecycle: string | null;
  authorization: string | null;
  authorizationReason: string | null;
  supportSatisfied: number | null;
  supportRequired: number | null;
  riskRewardRatio: number | null;
  strategyConfidence: number | null;
  checks: QuantCheckResult[];
  /** RiskEngine join by traceId - meaningful when the quant policy APPROVED (the idea then
   * flows through the unchanged RiskEngine spine). */
  risk: {
    reached: boolean;
    approved: boolean | null;
    rejectionGate: string | null;
    gateResults: Array<{ gateName: string; passed: boolean; detail: string | null }>;
  };
}

export interface GlobalTradingStateSummary {
  tradingState: 'TRADING_ENABLED' | 'TRADING_PAUSED' | 'EMERGENCY_STOP' | null;
  autobotEnabled: boolean | null;
  emergencyStopActive: boolean | null;
  broker: { id: string | null; ready: boolean | null; detail: string | null };
  marketData: {
    allocatedLines: number;
    receivingLines: number;
    freshLines: number;
    staleLines: number;
    errorLines: number;
    entitlementFailures: number;
    contractFailures: number;
  } | null;
}

/** Honest "could not read runtime state" value - every field null, never fabricated. Used by
 * tests via dependency injection so report tests stay hermetic. */
export const NULL_GLOBAL_TRADING_STATE: GlobalTradingStateSummary = {
  tradingState: null,
  autobotEnabled: null,
  emergencyStopActive: null,
  broker: { id: null, ready: null, detail: null },
  marketData: null,
};

export interface WhyNoTradeReport {
  symbol: string | null;
  /** A CONSENSUS_TERMINAL_REASON row was found (historical meaning, preserved). */
  found: boolean;
  /** Which terminal outcome is most recent when both consensus and quant evidence exist. */
  primaryPath: 'CONSENSUS' | 'QUANT_EXECUTION' | null;
  /** Epoch-ms of the consensus row, for recency comparison with the quant outcome. */
  evaluatedAtMs: number | null;
  traceId: string | null;
  candidateState: string | null;
  decisionTier: string | null;
  approved: boolean | null;
  terminalReasonCode: string | null;
  rawConfidence: number | null;
  finalConfidence: number | null;
  independentAgentCount: number | null;
  // 2026-09-20: distinct from independentAgentCount (raw distinct producer names) - structurally
  // correlated producers (e.g. QuantEngine + JavaCoreEnsemble, see evidenceIndependence.ts) collapse
  // to one group here. This is the value that actually gates MIN_INDEPENDENT_AGREEING_AGENTS.
  // Null for historical rows recorded before this field existed - never backfilled/guessed.
  independentEvidenceGroupCount: number | null;
  evidenceGroups: Array<{ agent: string; group: string }>;
  participatingAgents: Array<{ agent: string; side: string; confidence: number }>;
  risk: {
    reached: boolean;
    approved: boolean | null;
    rejectionGate: string | null;
    gateResults: Array<{ gateName: string; passed: boolean; detail: string | null }>;
  };
  // Phase 6 (Master Redesign Plan "Observability" section, 2026-09-27): narrowly computed for the
  // three known cooldown-style gates (same_symbol_cooldown / post_loss_cooldown / duplicate_signal)
  // whose own recorded detail JSON already carries the reference timestamp + cooldown window
  // (OvertradingGuards.ts) - no new data collection, just cooldownMs + referenceMs already
  // persisted in risk_gate_results.detail. Null for every other rejection reason (e.g. price
  // gates, market_hours, capital caps) where "next eligible" isn't a fixed clock time at all -
  // never fabricated as "now" or "unknown".
  nextEligibleReevaluationAt: string | null;
  /** Quant-first path terminal outcome (may exist with or without a consensus row). */
  quant: QuantPathOutcome;
  /** Live global state - the lead section when no terminal evaluation exists at all. */
  global: GlobalTradingStateSummary;
  /** Best-fit Part 42 category (see mapping comment at the top), or null when no emitter-backed
   * category applies. Never invented for gap categories. */
  mappedCategory: string | null;
}

const COOLDOWN_GATES_WITH_REFERENCE_TIMESTAMP: Record<string, string> = {
  same_symbol_cooldown: 'lastFillMs',
  post_loss_cooldown: 'lastLossMs',
};

/**
 * Computes a real "next eligible reevaluation" clock time for the small set of gates whose
 * OvertradingGuards.ts detail JSON already records both a reference timestamp and cooldownMs.
 * Never guesses for any other gate - returns null rather than fabricate a time.
 */
function computeNextEligibleReevaluationAt(
  rejectionGate: string | null,
  gates: Array<{ gateName: string; passed: boolean; detail: string | null }>,
): string | null {
  if (!rejectionGate) return null;
  const referenceField = COOLDOWN_GATES_WITH_REFERENCE_TIMESTAMP[rejectionGate];
  if (!referenceField) return null;
  const gate = gates.find((g) => g.gateName === rejectionGate && !g.passed);
  if (!gate?.detail) return null;
  try {
    const detail = JSON.parse(gate.detail);
    const referenceMs = detail[referenceField];
    const cooldownMs = detail.cooldownMs;
    if (typeof referenceMs !== 'number' || typeof cooldownMs !== 'number') return null;
    return new Date(referenceMs + cooldownMs).toISOString();
  } catch {
    return null;
  }
}

function parseJsonObject(raw: unknown): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw as string);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function emptyRiskChain() {
  return { reached: false, approved: null as boolean | null, rejectionGate: null as string | null, gateResults: [] as Array<{ gateName: string; passed: boolean; detail: string | null }> };
}

async function loadRiskChain(traceId: string | null) {
  const chain = emptyRiskChain();
  if (!traceId) return chain;
  const [riskRow] = await db.select().from(riskAssessments).where(eq(riskAssessments.traceId, traceId)).limit(1);
  if (!riskRow) return chain;
  const gates = await db.select().from(riskGateResults).where(eq(riskGateResults.traceId, traceId)).orderBy(riskGateResults.sequence);
  return {
    reached: true,
    approved: !!riskRow.approved,
    rejectionGate: riskRow.rejectionGate ?? null,
    gateResults: gates.map((g) => ({ gateName: g.gateName, passed: !!g.passed, detail: g.detail })),
  };
}

/**
 * Most recent quant-policy observability outcome (indexed eventType query). Mirrors the payload
 * shape ChiefTraderAgent's quant_policy_evaluated structured-log emits: eventType doubles as the
 * terminal code (QUANT_POLICY_APPROVED / QUANT_POLICY_REJECTED).
 */
async function findQuantPolicyOutcome(symbolUpper: string | null): Promise<QuantPathOutcome | null> {
  const whereClause = symbolUpper
    ? and(inArray(observabilityEvents.eventType, QUANT_POLICY_EVENT_TYPES), eq(observabilityEvents.symbol, symbolUpper))
    : inArray(observabilityEvents.eventType, QUANT_POLICY_EVENT_TYPES);
  const rows = await db.select().from(observabilityEvents)
    .where(whereClause)
    .orderBy(desc(observabilityEvents.ts)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = parseJsonObject(row.payload);
  const eventType = row.eventType as QuantTerminalEventType;
  const checks = Array.isArray(payload.checks)
    ? payload.checks.map((c: any) => ({
        id: String(c?.id ?? ''),
        category: String(c?.category ?? ''),
        passed: !!c?.passed,
        detail: typeof c?.detail === 'string' ? c.detail : (c?.detail != null ? JSON.stringify(c.detail) : null),
      }))
    : [];
  const traceId = row.traceId ?? (typeof payload.traceId === 'string' ? payload.traceId : null);
  return {
    found: true,
    tsMs: typeof row.ts === 'number' ? row.ts : null,
    eventType,
    symbol: (row.symbol ?? (typeof payload.symbol === 'string' ? payload.symbol : symbolUpper) ?? null),
    traceId,
    side: typeof payload.side === 'string' ? payload.side : null,
    approved: eventType === 'QUANT_POLICY_APPROVED',
    decisionPolicy: typeof payload.decisionPolicy === 'string' ? payload.decisionPolicy : 'QUANT_EXECUTION',
    reasonCode: typeof payload.reasonCode === 'string' ? payload.reasonCode : null,
    reason: typeof payload.reason === 'string' ? payload.reason : null,
    strategyId: typeof payload.strategyId === 'string' ? payload.strategyId : null,
    strategyLifecycle: typeof payload.strategyLifecycle === 'string' ? payload.strategyLifecycle : null,
    authorization: typeof payload.authorization === 'string' ? payload.authorization : null,
    authorizationReason: typeof payload.authorizationReason === 'string' ? payload.authorizationReason : null,
    supportSatisfied: numOrNull(payload.supportSatisfied),
    supportRequired: numOrNull(payload.supportRequired),
    riskRewardRatio: numOrNull(payload.riskRewardRatio),
    strategyConfidence: numOrNull(payload.strategyConfidence),
    checks,
    risk: await loadRiskChain(traceId),
  };
}

/**
 * QUANT_NOT_AUTHORIZED has no observability_events emitter (ChiefTraderAgent emits it only as an
 * EventBus DESK_NO_TRADE event, persisted to trade_lifecycle_transitions). Read the indexed
 * createdAt-desc window and match the DESK_NO_TRADE evidence payload in memory.
 */
async function findQuantNotAuthorized(symbolUpper: string | null): Promise<QuantPathOutcome | null> {
  const rows = await db.select().from(tradeLifecycleTransitions)
    .orderBy(desc(tradeLifecycleTransitions.createdAt))
    .limit(RECENT_LIFECYCLE_WINDOW);
  for (const row of rows) {
    if (row.state !== 'NO_TRADE') continue;
    if (symbolUpper && (row.symbol ?? '').toUpperCase() !== symbolUpper) continue;
    const evidence = parseJsonObject(row.evidenceJson);
    const payload = evidence && typeof evidence.payload === 'object' ? evidence.payload : {};
    if (payload.terminalReasonCode !== 'QUANT_NOT_AUTHORIZED') continue;
    const createdMs = Date.parse(row.createdAt);
    return {
      found: true,
      tsMs: Number.isFinite(createdMs) ? createdMs : null,
      eventType: 'QUANT_NOT_AUTHORIZED',
      symbol: row.symbol ?? null,
      traceId: typeof payload.traceId === 'string' ? payload.traceId : (row.candidateId ?? null),
      side: typeof payload.side === 'string' ? payload.side : null,
      approved: null, // the policy never evaluated this idea - authorization failed first
      decisionPolicy: typeof payload.decisionPolicy === 'string' ? payload.decisionPolicy : 'QUANT_EXECUTION',
      reasonCode: typeof payload.quantReasonCode === 'string' ? payload.quantReasonCode : null,
      reason: typeof payload.reason === 'string' ? payload.reason : (typeof row.reason === 'string' ? row.reason : null),
      strategyId: typeof payload.strategyId === 'string' ? payload.strategyId : null,
      strategyLifecycle: null,
      authorization: null,
      authorizationReason: typeof payload.authorizationReason === 'string' ? payload.authorizationReason : null,
      supportSatisfied: null,
      supportRequired: null,
      riskRewardRatio: null,
      strategyConfidence: null,
      checks: [],
      risk: emptyRiskChain(), // never reached RiskEngine - no consensus/policy approval existed
    };
  }
  return null;
}

function emptyQuantOutcome(): QuantPathOutcome {
  return {
    found: false, tsMs: null, eventType: null, symbol: null, traceId: null, side: null,
    approved: null, decisionPolicy: null, reasonCode: null, reason: null, strategyId: null,
    strategyLifecycle: null, authorization: null, authorizationReason: null, supportSatisfied: null,
    supportRequired: null, riskRewardRatio: null, strategyConfidence: null, checks: [],
    risk: emptyRiskChain(),
  };
}

/** Recency pick across the two quant evidence sources; null when neither fired. */
function pickQuantOutcome(a: QuantPathOutcome | null, b: QuantPathOutcome | null): QuantPathOutcome {
  if (a && b) {
    const aTs = a.tsMs ?? 0;
    const bTs = b.tsMs ?? 0;
    return bTs >= aTs ? b : a;
  }
  return a ?? b ?? emptyQuantOutcome();
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<T | null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Live global trading state - the report's lead section when no terminal evaluation exists at
 * all. Pure composition of existing read-only getters (dynamic imports so this observability
 * module never hard-couples to the engine layer at load time; same pattern as
 * processTelemetry.ts). Every sub-read is individually guarded: unreadable here (tests, partial
 * boot) yields null fields, never fabricated values.
 */
export async function readGlobalTradingState(): Promise<GlobalTradingStateSummary> {
  const out: GlobalTradingStateSummary = {
    ...NULL_GLOBAL_TRADING_STATE,
    broker: { ...NULL_GLOBAL_TRADING_STATE.broker },
  };
  const reads: Array<Promise<void>> = [
    (async () => {
      try {
        const { tradingEngine } = await import('../engines/TradingEngine');
        const s = tradingEngine?.state;
        if (s) {
          out.tradingState = (s.tradingState === 'TRADING_ENABLED' || s.tradingState === 'TRADING_PAUSED' || s.tradingState === 'EMERGENCY_STOP') ? s.tradingState : null;
          out.autobotEnabled = typeof s.enabled === 'boolean' ? s.enabled : null;
          out.emergencyStopActive = typeof s.emergencyStopActive === 'boolean' ? s.emergencyStopActive : null;
        }
      } catch { /* unreadable - nulls stand */ }
    })(),
    (async () => {
      try {
        const { argusRuntime } = await import('../core/ArgusRuntime');
        const readiness = await withTimeout(argusRuntime.brokerReadiness(), 5000);
        if (readiness) out.broker = { id: out.broker.id, ready: !!readiness.ready, detail: readiness.detail ?? null };
      } catch { /* unreadable - nulls stand */ }
      // NOTE: BrokerManager is NOT imported here (architecture protection: only allowlisted
      // files may import it). The broker id comes from readiness.detail when available;
      // otherwise it stays null. This is an observability report, not a trading path.
    })(),
    (async () => {
      try {
        const { buildMarketDataDiagnosticsReport } = await import('./marketDataDiagnosticsReport');
        const md = await withTimeout(Promise.resolve(buildMarketDataDiagnosticsReport()), 5000);
        const s = md?.summary;
        if (s) {
          out.marketData = {
            allocatedLines: s.allocatedLines, receivingLines: s.receivingLines, freshLines: s.freshLines,
            staleLines: s.staleLines, errorLines: s.errorLines,
            entitlementFailures: s.entitlementFailures, contractFailures: s.contractFailures,
          };
        }
      } catch { /* unreadable - null stands */ }
    })(),
  ];
  await withTimeout(Promise.all(reads), 8000);
  return out;
}

/** Best-fit Part 42 category from already-persisted evidence (see mapping comment at top).
 * TRADING_PAUSED wins over everything: an evaluation row cannot trade while the machine is paused. */
export function deriveMappedCategory(args: {
  tradingState: GlobalTradingStateSummary['tradingState'];
  brokerReady: boolean | null;
  quant: QuantPathOutcome;
  consensusFound: boolean;
  terminalReasonCode: string | null;
  riskReached: boolean;
  riskApproved: boolean | null;
  primaryPath: 'CONSENSUS' | 'QUANT_EXECUTION' | null;
}): string | null {
  if (args.tradingState === 'TRADING_PAUSED' || args.tradingState === 'EMERGENCY_STOP') return 'TRADING_PAUSED';
  if (args.brokerReady === false) return 'BROKER_UNAVAILABLE';
  // The primary path (newest terminal outcome) determines the category. A stale quant
  // rejection must not shadow a newer consensus evaluation, and vice versa.
  if (args.primaryPath === 'QUANT_EXECUTION') {
    if (args.quant.found && args.quant.eventType === 'QUANT_NOT_AUTHORIZED') return 'QUANT_NOT_AUTHORIZED';
    if (args.quant.found && args.quant.eventType === 'QUANT_POLICY_REJECTED') return 'QUANT_POLICY_REJECTED';
    if (args.riskReached && args.riskApproved === false) return 'RISK_REJECTED';
  } else if (args.primaryPath === 'CONSENSUS') {
    if (args.riskReached && args.riskApproved === false) return 'RISK_REJECTED';
    if (args.consensusFound && args.terminalReasonCode && args.terminalReasonCode !== 'CONSENSUS_APPROVED') return 'CONSENSUS_INSUFFICIENT';
    // A stale quant rejection does not shadow the newer consensus path; fall through.
  } else {
    // No primary path (should not happen when called with real outcomes) - legacy order.
    if (args.quant.found && args.quant.eventType === 'QUANT_NOT_AUTHORIZED') return 'QUANT_NOT_AUTHORIZED';
    if (args.quant.found && args.quant.eventType === 'QUANT_POLICY_REJECTED') return 'QUANT_POLICY_REJECTED';
    if (args.riskReached && args.riskApproved === false) return 'RISK_REJECTED';
    if (args.consensusFound && args.terminalReasonCode && args.terminalReasonCode !== 'CONSENSUS_APPROVED') return 'CONSENSUS_INSUFFICIENT';
  }
  return null;
}

export interface BuildWhyNoTradeDeps {
  /** Injected in tests so report tests stay hermetic; production default reads live runtime. */
  readGlobalState?: () => Promise<GlobalTradingStateSummary>;
}

// Filters by eventType at the SQL level (not just symbol, then in-memory .find over a capped
// window) - noisier event types (ticks, subscriptions) for an actively-scanned symbol can easily
// outnumber its real CONSENSUS_TERMINAL_REASON rows within any small in-memory window, which would
// silently hide a real historical evaluation behind a false "not found".
export async function buildWhyNoTradeReport(symbol?: string, deps?: BuildWhyNoTradeDeps): Promise<WhyNoTradeReport> {
  const symbolUpper = symbol ? symbol.toUpperCase() : null;
  const whereClause = symbolUpper
    ? and(eq(observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON'), eq(observabilityEvents.symbol, symbolUpper))
    : eq(observabilityEvents.eventType, 'CONSENSUS_TERMINAL_REASON');
  const rows = await db.select().from(observabilityEvents)
    .where(whereClause)
    .orderBy(desc(observabilityEvents.ts)).limit(1);

  const [consensusRow, quant, global] = await Promise.all([
    Promise.resolve(rows[0] ?? null),
    (async () => pickQuantOutcome(await findQuantPolicyOutcome(symbolUpper), await findQuantNotAuthorized(symbolUpper)))(),
    (deps?.readGlobalState ? deps.readGlobalState() : readGlobalTradingState()),
  ]);

  const row = consensusRow;
  const consensusTsMs = row && typeof row.ts === 'number' ? row.ts : null;
  // Most recent terminal outcome wins the lead section; ties/consensus-only keep the historical
  // consensus rendering. A quant outcome never rewrites consensus detail - it is shown alongside.
  const quantTsMs = quant.found ? (quant.tsMs ?? 0) : -1;
  const primaryPath: 'CONSENSUS' | 'QUANT_EXECUTION' | null =
    row ? (quant.found && quantTsMs > (consensusTsMs ?? 0) ? 'QUANT_EXECUTION' : 'CONSENSUS')
        : (quant.found ? 'QUANT_EXECUTION' : null);

  const mappedCategory = deriveMappedCategory({
    tradingState: global.tradingState,
    brokerReady: global.broker.ready,
    quant,
    consensusFound: !!row,
    terminalReasonCode: null, // filled below once payload is parsed
    riskReached: false,
    riskApproved: null,
    primaryPath,
  });

  if (!row) {
    // No consensus evaluation: the quant path may still have a terminal outcome. If it does
    // and carries a traceId, load its risk chain (an approved quant idea flows through
    // RiskEngine) so RISK_REJECTED is correctly mapped when the policy approved but a
    // risk gate rejected.
    let quantRisk = emptyRiskChain();
    let quantMappedCategory = mappedCategory;
    if (quant.found && quant.traceId) {
      quantRisk = await loadRiskChain(quant.traceId);
      quantMappedCategory = deriveMappedCategory({
        tradingState: global.tradingState,
        brokerReady: global.broker.ready,
        quant,
        consensusFound: false,
        terminalReasonCode: null,
        riskReached: quantRisk.reached,
        riskApproved: quantRisk.approved,
        primaryPath,
      });
    }
    return {
      symbol: symbolUpper,
      found: false,
      primaryPath,
      evaluatedAtMs: null,
      traceId: null,
      candidateState: symbolUpper ? getCandidate(symbolUpper)?.state ?? null : null,
      decisionTier: null,
      approved: null,
      terminalReasonCode: null,
      rawConfidence: null,
      finalConfidence: null,
      independentAgentCount: null,
      independentEvidenceGroupCount: null,
      evidenceGroups: [],
      participatingAgents: [],
      risk: quantRisk,
      nextEligibleReevaluationAt: null,
      quant,
      global,
      mappedCategory: quantMappedCategory,
    };
  }

  const payload = parseJsonObject(row.payload);

  const resolvedSymbol = (row.symbol ?? payload.symbol ?? symbol ?? '').toUpperCase() || null;
  const traceId = row.traceId ?? payload.traceId ?? null;
  const risk = await loadRiskChain(traceId);

  const terminalReasonCode: string | null = typeof payload.terminalReasonCode === 'string' ? payload.terminalReasonCode : null;
  // Re-derive with the parsed consensus payload (the placeholder call above could not see it).
  const finalMappedCategory = deriveMappedCategory({
    tradingState: global.tradingState,
    brokerReady: global.broker.ready,
    quant,
    consensusFound: true,
    terminalReasonCode,
    riskReached: risk.reached,
    riskApproved: risk.approved,
    primaryPath,
  });

  return {
    symbol: resolvedSymbol,
    found: true,
    primaryPath,
    evaluatedAtMs: consensusTsMs,
    traceId,
    candidateState: resolvedSymbol ? getCandidate(resolvedSymbol)?.state ?? null : null,
    decisionTier: payload.decisionTier ?? null,
    approved: typeof payload.approved === 'boolean' ? payload.approved : null,
    terminalReasonCode,
    rawConfidence: numOrNull(payload.rawConfidence),
    finalConfidence: numOrNull(payload.finalConfidence),
    independentAgentCount: numOrNull(payload.independentAgentCount),
    independentEvidenceGroupCount: numOrNull(payload.independentEvidenceGroupCount),
    evidenceGroups: Array.isArray(payload.evidenceGroups) ? payload.evidenceGroups : [],
    participatingAgents: Array.isArray(payload.participatingAgents) ? payload.participatingAgents : [],
    risk,
    nextEligibleReevaluationAt: computeNextEligibleReevaluationAt(risk.rejectionGate ?? null, risk.gateResults),
    quant,
    global,
    mappedCategory: finalMappedCategory,
  };
}

function formatGlobalBlock(g: GlobalTradingStateSummary): string[] {
  const md = g.marketData;
  return [
    `Trading state: ${g.tradingState ?? 'UNKNOWN'}${g.emergencyStopActive ? ' (emergency stop ACTIVE)' : ''}`,
    `Autobot: ${g.autobotEnabled == null ? 'unknown' : g.autobotEnabled ? 'ON' : 'OFF'}`,
    `Broker: ${g.broker.id ?? 'unknown'} - ${g.broker.ready == null ? 'readiness unknown' : g.broker.ready ? 'READY' : `NOT READY (${g.broker.detail ?? 'no detail'})`}`,
    md
      ? `Market data: ${md.allocatedLines} allocated / ${md.receivingLines} receiving (${md.freshLines} fresh, ${md.staleLines} stale) / ${md.errorLines} error / ${md.entitlementFailures} entitlement failures / ${md.contractFailures} contract failures`
      : 'Market data: unavailable',
  ];
}

function formatGlobalOneLiner(g: GlobalTradingStateSummary): string {
  const md = g.marketData;
  const broker = g.broker.ready == null ? '?' : g.broker.ready ? 'ok' : 'DOWN';
  return `Global: trading=${g.tradingState ?? '?'} autobot=${g.autobotEnabled == null ? '?' : g.autobotEnabled ? 'on' : 'off'} broker=${g.broker.id ?? '?'}(${broker})` +
    (md ? ` mktdata=${md.receivingLines}/${md.allocatedLines}recv ${md.freshLines}f/${md.staleLines}s` : ' mktdata=?');
}

function formatQuantSection(q: QuantPathOutcome): string[] {
  const lines = [
    `Path: QUANT_EXECUTION - ${q.eventType ?? 'UNKNOWN'}`,
    q.side ? `Side: ${q.side}` : '',
    q.strategyId ? `Strategy: ${q.strategyId}${q.strategyLifecycle ? ` (lifecycle ${q.strategyLifecycle})` : ''}` : '',
    q.authorization || q.authorizationReason ? `Authorization: ${q.authorization ?? '?'}${q.authorizationReason ? ` - ${q.authorizationReason}` : ''}` : '',
    q.reasonCode ? `Reason code: ${q.reasonCode}` : '',
    q.reason ? `Reason: ${q.reason}` : '',
  ];
  const metrics: string[] = [];
  if (q.supportSatisfied != null && q.supportRequired != null) metrics.push(`support ${q.supportSatisfied}/${q.supportRequired}`);
  if (q.riskRewardRatio != null) metrics.push(`R:R ${q.riskRewardRatio}`);
  if (q.strategyConfidence != null) metrics.push(`strategy confidence ${q.strategyConfidence}`);
  if (metrics.length > 0) lines.push(`Metrics: ${metrics.join(' · ')}`);
  if (q.checks.length > 0) {
    lines.push('Policy checks:');
    for (const c of q.checks) {
      lines.push(`  ${c.id.padEnd(34)}${c.passed ? 'PASS' : 'FAIL'}${c.detail ? ` - ${c.detail}` : ''}`);
    }
  }
  if (q.risk.reached) {
    lines.push(`RiskEngine: ${q.risk.approved ? 'PASS' : 'FAIL'}${q.risk.rejectionGate ? ` (${q.risk.rejectionGate})` : ''}`);
  }
  return lines.filter((l) => l !== '');
}

export function formatWhyNoTradeReport(r: WhyNoTradeReport): string {
  const hasTerminal = r.found || r.quant.found;

  if (!hasTerminal) {
    return [
      `Symbol: ${r.symbol ?? '(most recent)'}`,
      '',
      ...formatGlobalBlock(r.global),
      '',
      'Deeper drill-down: argus market-data-diagnostics --symbols=<SYM> | argus discovery-lineage --symbol=<SYM>',
      '',
      r.candidateState ? `Candidate lifecycle state: ${r.candidateState}` : 'No candidate lifecycle record found.',
      'No CONSENSUS_TERMINAL_REASON or quant-policy terminal evaluation found for this symbol.',
      r.mappedCategory ? `Best-fit category: ${r.mappedCategory}` : '',
    ].filter((l) => l !== '').join('\n');
  }

  const lines = [
    `Symbol: ${r.symbol}`,
    `Trace: ${r.traceId ?? r.quant.traceId ?? '(none)'}`,
    formatGlobalOneLiner(r.global),
    r.candidateState ? `Candidate: ${r.candidateState}` : '',
    '',
  ];

  const quantFirst = r.primaryPath === 'QUANT_EXECUTION';
  const quantNote = r.quant.found
    ? `Quant path: ${r.quant.eventType}${r.quant.reasonCode ? ` (${r.quant.reasonCode})` : ''}${r.quant.tsMs ? ` at ${new Date(r.quant.tsMs).toISOString()}` : ''}`
    : '';

  if (quantFirst) {
    lines.push(...formatQuantSection(r.quant));
    lines.push('');
    if (r.found) {
      lines.push('(An older consensus evaluation also exists - shown below; the quant outcome above is the most recent terminal outcome.)');
      lines.push('');
    }
  }

  if (r.found) {
    if (!quantFirst && quantNote) lines.push(`${quantNote} (older than this consensus evaluation)`, '');
    for (const a of r.participatingAgents) {
      lines.push(`${a.agent}: ${a.side} ${typeof a.confidence === 'number' ? a.confidence.toFixed(3) : a.confidence}`);
    }
    lines.push('');
    lines.push(`Independent agreement: ${r.independentAgentCount ?? 0} raw producer(s) -> ${r.independentEvidenceGroupCount ?? 'N/A (pre-fix row)'} independent evidence group(s)`);
    if (r.evidenceGroups.length > 0) {
      const merged = r.evidenceGroups.filter((g, i, arr) => arr.some((o, j) => j !== i && o.group === g.group));
      if (merged.length > 0) {
        lines.push(`  Merged as correlated: ${merged.map(g => `${g.agent}->${g.group}`).join(', ')}`);
      }
    }
    lines.push(`Decision tier: ${r.decisionTier ?? 'N/A'}`);
    lines.push(`Consensus: ${r.approved ? 'PASS' : 'FAIL'} (${r.terminalReasonCode ?? 'UNKNOWN'})`);
    lines.push(`Raw confidence: ${r.rawConfidence ?? 'N/A'}   Final confidence: ${r.finalConfidence ?? 'N/A'}`);
    lines.push('');
    if (r.risk.reached) {
      lines.push(`RiskEngine: ${r.risk.approved ? 'PASS' : 'FAIL'}${r.risk.rejectionGate ? ` (${r.risk.rejectionGate})` : ''}`);
      for (const g of r.risk.gateResults) {
        lines.push(`  ${g.gateName.padEnd(28)}${g.passed ? 'PASS' : 'FAIL'}`);
      }
    } else {
      lines.push('RiskEngine: NOT REACHED (no consensus approval for this evaluation)');
    }
    if (r.nextEligibleReevaluationAt) {
      lines.push(`Next eligible reevaluation: ${r.nextEligibleReevaluationAt} (cooldown gate: ${r.risk.rejectionGate})`);
    }
    lines.push('');
    lines.push(`Final: ${r.approved && r.risk.approved ? 'TRADE' : 'NO_TRADE'}`);
  } else {
    // Quant-only terminal outcome (no consensus row at all).
    lines.push(...formatQuantSection(r.quant));
    lines.push('');
    if (r.quant.risk.reached) {
      lines.push(`Final: ${r.quant.approved && r.quant.risk.approved ? 'TRADE' : 'NO_TRADE'}`);
    } else {
      lines.push(`Final: ${r.quant.approved ? 'APPROVED_BY_POLICY (RiskEngine outcome not yet persisted for this trace)' : 'NO_TRADE'}`);
    }
  }

  if (r.mappedCategory) {
    lines.push(`Best-fit category: ${r.mappedCategory}`);
  }
  return lines.join('\n');
}
