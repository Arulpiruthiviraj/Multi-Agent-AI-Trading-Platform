import { classifySessionCheckpoint, SESSION_CHECKPOINT_SLOTS_ET, type SessionCheckpointInput, type SessionCheckpointClassification } from './sessionCheckpointClassification';
export { classifySessionCheckpoint, SESSION_CHECKPOINT_SLOTS_ET, type SessionCheckpointInput, type SessionCheckpointClassification, type SessionCheckpointVerdict } from './sessionCheckpointClassification';
/**
 * Session checkpoint classifier (Mission Part 57, 2026-10-07).
 *
 * Early-warning inactivity detection for PAPER sessions. At operator checkpoint times
 * (09:35 / 10:00 / 11:00 / 13:00 / 15:00 ET) the operator — or a cron — runs
 * `argus session-checkpoint`; this module classifies the current session from
 * already-persisted observability evidence as HEALTHY_ZERO_TRADE or SUSPICIOUS_ZERO_TRADE
 * (TRADING when terminal outcomes exist).
 *
 * Heuristic (reporting only, not a threshold/gate change — nothing here alters any
 * decision, threshold, gate, or trading state):
 *   SUSPICIOUS_ZERO_TRADE = upstream pipeline activity is flowing
 *     (discoveries / subscriptions / quant assessments / ideas / consensus rounds /
 *     risk evaluations) but ZERO terminal outcomes (approvals / risk approvals /
 *     orders / fills) AND a fixable global blocker exists:
 *       - TRADING_PAUSED
 *       - broker down
 *       - subscription starvation (no usable subscriptions)
 *   All-AI-down is deliberately NOT a fixable blocker: this is a quant-first system and
 *   AI is optional — healthy quant should still flow with AI down, so an all-AI-down
 *   morning with a flowing quant pipeline is HEALTHY, not suspicious.
 *
 * READ-ONLY: composes existing report builders (tradingSessionReport,
 * consensusPipelineReport, quantEvidenceReport, marketDataDiagnostics/readiness,
 * TradingReadinessGate) and read-only DB selects. Never arms LIVE, never pauses or
 * resumes trading, never places/blocks an order, never changes a threshold.
 */
import { getPipelineAgentSnapshot } from '../core/pipelineAgentSnapshot';
import { getTradingSessionReport } from '../core/tradingSessionReport';
import { getMarketDataReadiness } from '../core/marketDataReadiness';
import { computeAiAvailability, computeQuantAvailability } from '../core/aiQuantAvailability';
import { getTradingReadinessSnapshot } from '../core/TradingReadinessGate';
import { buildConsensusPipelineReport } from './consensusPipelineReport';
import { buildQuantEvidenceReport } from './quantEvidenceReport';
import { allowsNewEntryIdeas } from '../core/sessionRecovery';
import { marketDataWorker } from '../services/MarketDataWorker';
import { latestCycleIsMatch } from '../services/reconciliationOperatorSnapshot';
import { getMetric } from './ObservabilityMetrics';
import { observabilityQueueLengthForTests } from './ObservabilityStore';
import { db } from '../db';
import * as schema from '../db/schema';
import { desc, and, eq, gte, lt, count, sql } from 'drizzle-orm';
import { replaySafety } from '../replay/replaySafety';
import { buildQuantReadinessReport } from '../routes/v2Diagnostics';
import { isQuantPolicyEnabled } from '../config/quantDecisionPolicy';

export interface SessionCheckpointReport {
  generatedAt: string;
  checkpointSlot: string;
  windowSinceIso: string;
  input: SessionCheckpointInput;
  classification: SessionCheckpointClassification;
}

/** Which checkpoint slot the operator is at/past right now (America/New_York), pure. */
export function checkpointSlotLabel(nowMs: number): string {
  const et = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(nowMs));
  const past = SESSION_CHECKPOINT_SLOTS_ET.filter((s) => s <= et);
  if (past.length === 0) return `pre-${SESSION_CHECKPOINT_SLOTS_ET[0]} (now ${et} ET)`;
  return `post-${past[past.length - 1]} (now ${et} ET)`;
}

/** UTC instant of the start of the current America/New_York calendar day, as ISO. Pure. */
export function etDayStartIso(nowMs: number): string {
  const tz = 'America/New_York';
  const offsetMinutesAt = (instantMs: number): number => {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(instantMs));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Math.round((asUtc - instantMs) / 60000);
  };
  const etNow = new Date(nowMs + offsetMinutesAt(nowMs) * 60000);
  const etMidnightAsUtc = Date.UTC(etNow.getUTCFullYear(), etNow.getUTCMonth(), etNow.getUTCDate());
  return new Date(etMidnightAsUtc - offsetMinutesAt(etMidnightAsUtc) * 60000).toISOString();
}

/**
 * Pure classification. Reporting only — the numbers in must already exist; this function
 * invents no data, changes no threshold, and touches no trading state.
 */
/**
 * Compose the checkpoint input from existing read-only reports. Every number below comes
 * from an already-real, already-tested source — no new counters, no new data paths.
 */
export async function buildSessionCheckpoint(): Promise<SessionCheckpointReport> {
  const nowMs = Date.now();
  const sinceIso = etDayStartIso(nowMs);

  const pipeline = getPipelineAgentSnapshot();
  const marketDataReadiness = getMarketDataReadiness();
  const [sessionReport, consensus, quantEvidence, aiAvail, quantAvail, readiness] = await Promise.all([
    getTradingSessionReport({
      activeSymbols: marketDataWorker.getActiveSymbols().length,
      maxSymbols: marketDataWorker.getEffectiveStreamingCap(),
      interruptedSessionHold: !allowsNewEntryIdeas(),
    }),
    buildConsensusPipelineReport(sinceIso),
    buildQuantEvidenceReport(sinceIso),
    computeAiAvailability(),
    computeQuantAvailability(),
    getTradingReadinessSnapshot(),
  ]);

  const brokerNode = readiness.nodes.find((n) => n.id === 'broker');
  let reconciliationMatch: boolean | null = null;
  try {
    const [latest] = await db
      .select()
      .from(schema.reconciliationEvents)
      .orderBy(desc(schema.reconciliationEvents.id))
      .limit(1);
    reconciliationMatch = latest ? latestCycleIsMatch(latest) : null;
  } catch {
    reconciliationMatch = null;
  }

  let observabilityQueuePending = 0;
  try {
    // Read-only queue.length accessor; the ForTests suffix is historical (no production
    // accessor exists and this module must not change observability plumbing).
    observabilityQueuePending = observabilityQueueLengthForTests();
  } catch {
    observabilityQueuePending = 0;
  }
  let observabilityQueueDropped = 0;
  try {
    observabilityQueueDropped = getMetric('events_dropped_queue_full');
  } catch {
    observabilityQueueDropped = 0;
  }

  const input: SessionCheckpointInput = {
    tradingState: pipeline.tradingState ?? 'UNKNOWN',
    autobotEnabled: pipeline.autobotEnabled === true,
    brokerDown: brokerNode ? brokerNode.ready !== true : false,
    marketSession: sessionReport.market.session,
    marketDataReady: sessionReport.market.marketDataReady,
    symbolsDiscovered: sessionReport.market.activeSymbols,
    subscriptionsActive: marketDataReadiness.activeSymbols,
    subscriptionsFresh: marketDataReadiness.freshSymbols,
    quantAssessments: quantEvidence.totalProduced,
    quantValidationFailed: quantEvidence.totalValidationFailed,
    strategyTriggers: consensus.evaluations,
    quantIdeas: sessionReport.decisionPipeline.ideasGenerated,
    consensusRoundsStarted: sessionReport.decisionPipeline.consensusRoundsStarted,
    consensusRejected: sessionReport.decisionPipeline.consensusRejected,
    quantApprovals: sessionReport.decisionPipeline.chiefTraderApproved,
    riskEvaluations: sessionReport.execution.riskEvaluations,
    riskApproved: sessionReport.execution.riskApproved,
    ordersSubmitted: sessionReport.execution.ordersSubmitted,
    fills: sessionReport.execution.fills,
    topTerminalReasons: consensus.topTerminalReasons,
    aiAvailability: aiAvail.state,
    aiHealthyProviders: aiAvail.healthyProviderCount,
    aiTotalProviders: aiAvail.registeredProviderCount,
    quantAvailability: quantAvail.state,
    observabilityQueuePending,
    observabilityQueueDropped,
    reconciliationMatch,
    quantPolicyEnabled: isQuantPolicyEnabled(),
  };

  // Canonical authorization and observed policy outcomes are separate evidence.
  // A read failure remains unknown; it must never become fabricated zero activity.
  if (input.quantPolicyEnabled) {
    try {
      input.authorizedPaperQuantStrategies = (await buildQuantReadinessReport()).summary.authorizedQuantPolicy;
      input.quantPolicyEvaluations = await readObservedQuantPolicyEvaluations(Date.parse(sinceIso), nowMs);
    } catch { /* unknown evidence is explicitly disclosed by classification */ }
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    checkpointSlot: checkpointSlotLabel(nowMs),
    windowSinceIso: sinceIso,
    input,
    classification: classifySessionCheckpoint(input),
  };
}

/** Text renderer for cron/operator runs. Pure. */
export function formatSessionCheckpointText(r: SessionCheckpointReport): string {
  const i = r.input;
  const c = r.classification;
  const lines = [
    'ARGUS SESSION CHECKPOINT (early-warning inactivity detection)',
    '============================================================',
    `Generated:        ${r.generatedAt}`,
    `Checkpoint slot:  ${r.checkpointSlot}`,
    `Window since:     ${r.windowSinceIso} (current ET trading day)`,
    '',
    `VERDICT: ${c.verdict}`,
    ...c.reasons.map((x) => `  - ${x}`),
    ...(c.blockers.length > 0 ? [`Fixable blockers: ${c.blockers.join(', ')}`] : []),
    '',
    'PIPELINE COUNTS (real, this session)',
    '------------------------------------',
    `Trading state:            ${i.tradingState} (autobot ${i.autobotEnabled ? 'enabled' : 'disabled'})`,
    `Market session:           ${i.marketSession} | market data ready: ${i.marketDataReady}`,
    `Symbols discovered:       ${i.symbolsDiscovered} | subscriptions active/fresh: ${i.subscriptionsActive}/${i.subscriptionsFresh}`,
    `Quant assessments:        ${i.quantAssessments} (validation failed: ${i.quantValidationFailed})`,
    `Quant policy:             ${i.quantPolicyEnabled === true ? 'enabled' : 'disabled'} | authorized strategies ${i.authorizedPaperQuantStrategies ?? 'UNKNOWN'} | evaluations ${i.quantPolicyEvaluations ?? 'UNKNOWN'}`,
    `Strategy triggers (evals): ${i.strategyTriggers}`,
    `Trade ideas:              ${i.quantIdeas} | consensus rounds: ${i.consensusRoundsStarted} (rejected pre-consensus: ${i.consensusRejected})`,
    `Chief approvals:          ${i.quantApprovals} | risk evals: ${i.riskEvaluations} (approved: ${i.riskApproved})`,
    `Orders submitted:         ${i.ordersSubmitted} | fills: ${i.fills}`,
    `AI: ${i.aiAvailability} (${i.aiHealthyProviders}/${i.aiTotalProviders} healthy — advisory only) | Quant: ${i.quantAvailability}`,
    `Broker: ${i.brokerDown ? 'DOWN' : 'up'} | reconciliation: ${
      i.reconciliationMatch === null ? 'no cycles recorded' : i.reconciliationMatch ? 'MATCH' : 'MISMATCH'
    }`,
    `Observability queue: pending ${i.observabilityQueuePending}, dropped ${i.observabilityQueueDropped}`,
    `Upstream activity: ${c.upstreamActivity} | terminal outcomes: ${c.terminalOutcomes}`,
    '',
    'Note: read-only diagnostic. AI-down never fails quant readiness (quant-first). ' +
      'Run at 09:35 / 10:00 / 11:00 / 13:00 / 15:00 ET during PAPER sessions.',
  ];
  return lines.join('\n');
}

/** Read-only observed policy outcomes, half-open UTC window; replay is excluded. */
export async function readObservedQuantPolicyEvaluations(sinceMs: number, untilMs: number): Promise<number> {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs <= sinceMs) throw new Error("Invalid policy activity window");
  let policyEvaluations = 0;
  for (const eventType of ['QUANT_POLICY_APPROVED', 'QUANT_POLICY_REJECTED']) {
    const [row] = await db.select({ total: count() }).from(schema.observabilityEvents).where(and(
      eq(schema.observabilityEvents.eventType, eventType),
      gte(schema.observabilityEvents.ts, sinceMs),
      lt(schema.observabilityEvents.ts, untilMs),
      sql`(${schema.observabilityEvents.traceId} IS NULL OR substr(${schema.observabilityEvents.traceId}, 1, ${replaySafety.replayTracePrefix.length}) <> ${replaySafety.replayTracePrefix})`,
    ));
    policyEvaluations += row.total;
  }
  return policyEvaluations;
}
