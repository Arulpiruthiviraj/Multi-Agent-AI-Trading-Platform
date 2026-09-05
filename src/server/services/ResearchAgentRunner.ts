/**
 * ==========================================================
 * ResearchAgentRunner.ts
 *
 * Node-side orchestration for the isolated LangGraph research service
 * (docs/architecture/ARGUS_ARCHITECTURE.md (LangGraph Research Service section)). This is the ONLY place a LangGraph result is
 * written to Argus's database - the Python process never opens data/argus.db itself; it returns a
 * validated JSON envelope over HTTP (LangGraphResearchService.ts), and this file persists it
 * through the existing DB singleton (src/server/db/index.ts), exactly like any other agent's
 * output.
 *
 * SHADOW ONLY: a run here never emits a live trade-idea or chief-approval event onto the EventBus,
 * never calls RiskEngine/OrderManagement/BrokerManager, never mutates StrategyEngine.ts's strategy
 * arrays, and never promotes anything. Its result is advisory research a human may choose to act
 * on by hand - see langGraphArchitectureBoundary.test.ts for the automated check that this stays
 * true.
 *
 * Phase 3.1 (2026-09-03, asynchronous research execution lifecycle): a real production race was
 * found live - a genuine LLM-backed run (11-16s) can exceed server.ts's blanket 15s /api
 * request-timeout backstop. The prior synchronous begin+complete-in-one-call design is split:
 *
 *   beginStrategyGraduationRun()    - fast: validates, recovers any orphaned runs from a prior
 *                                     process (once per process), creates a PENDING row, returns
 *                                     immediately. This is what the HTTP route now awaits.
 *   completeStrategyGraduationRun() - slow: the real LangGraph call + persistence. Called
 *                                     detached (fire-and-forget) by the route so its latency can
 *                                     never race the global HTTP timeout again.
 *   runStrategyGraduationRecommendation() - thin wrapper (begin then await complete) kept for the
 *                                     one caller that still wants synchronous behavior on purpose:
 *                                     the CLI's own `research-recommend` command, which now polls
 *                                     the read API instead of relying on this wrapper directly -
 *                                     see scripts/argus-cli.ts. Existing tests that mock this
 *                                     function directly keep working unchanged.
 *
 * State machine (research_agent_runs.status): PENDING -> RUNNING -> one terminal state
 * (COMPLETED | FAILED | UNAVAILABLE | TIMEOUT | CANCELLED | FAILED_ON_RESTART). Every transition
 * away from PENDING/RUNNING is a single conditional UPDATE guarded by
 * `WHERE status IN ('PENDING','RUNNING')` - this is what makes completion idempotent and prevents
 * double-finalization (a cancellation that lands between the LangGraph call finishing and this
 * file's own completion write simply wins the race; the completion write becomes a no-op against
 * an already-terminal row, never overwriting it).
 * ==========================================================
 */
import { v4 as uuidv4 } from 'uuid';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { researchAgentRuns } from '../db/schema';
import { langGraphResearchService, type LangGraphResearchOutcome } from './LangGraphResearchService';
import { langGraphResearch } from '../config/langGraphResearch';

export type ResearchRunStatus =
  | 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED' | 'FAILED_ON_RESTART';

const NON_TERMINAL_STATUSES: ResearchRunStatus[] = ['PENDING', 'RUNNING'];

export interface StrategyGraduationRunRequest {
  strategyId: string;
  correlationId?: string;
  /** ResearchTriggerEngine (2026-09-04): defaults to MANUAL (the original, only, behavior) when
   *  omitted - every pre-existing caller (the HTTP route) is unaffected. */
  triggerType?: 'MANUAL' | 'TRADE_BATCH';
  triggerReason?: string;
  /** Idempotency key for automatic triggers - the real-world event (e.g. a fill's trade id) this
   *  run was created for. Omitted (null) for MANUAL runs, which have no single triggering event. */
  triggerEventId?: string;
  /** What the trigger actually knew at decision time - see schema.ts's own comment on why this is
   *  preserved rather than left to be re-derived later from mutable current state. */
  evidenceSnapshot?: Record<string, unknown>;
}

export interface StrategyGraduationRunOutcome {
  runId: string;
  correlationId: string;
  status: ResearchRunStatus;
  outcome?: LangGraphResearchOutcome;
}

// --- Bounded concurrency (Part C/Q): config/langGraphResearch.json's maxConcurrentRuns was
// loaded/validated but never actually enforced anywhere - a real gap confirmed by grep before this
// change. In-process counter only (single Node process is the sole writer/orchestrator here;
// no distributed state needed - Part Q explicitly says not to introduce one). ---
let activeRunCount = 0;

function tryAcquireRunSlot(): boolean {
  if (activeRunCount >= langGraphResearch.maxConcurrentRuns) return false;
  activeRunCount++;
  return true;
}

function releaseRunSlot(): void {
  activeRunCount = Math.max(0, activeRunCount - 1);
}

/** Test-only: reset the in-process concurrency counter between tests. */
export function resetResearchRunConcurrencyForTests(): void {
  activeRunCount = 0;
}

// --- Restart recovery (Part D/E): a PENDING/RUNNING row left behind by a prior process (killed,
// crashed, or restarted mid-run) can never be resumed - the in-memory background task that would
// have completed it is gone. Runs exactly once per process, lazily, before the first new run this
// process starts - so old orphans are always cleaned up before any new state is created, without
// needing a dedicated boot-sequence hook in ArgusCoreBoot.ts/server.ts. ---
let hasRecoveredOrphansThisProcess = false;

async function recoverOrphanedResearchRunsOnce(): Promise<void> {
  if (hasRecoveredOrphansThisProcess) return;
  hasRecoveredOrphansThisProcess = true;
  try {
    const orphaned = await db.select().from(researchAgentRuns).where(inArray(researchAgentRuns.status, NON_TERMINAL_STATUSES));
    for (const row of orphaned) {
      await db.update(researchAgentRuns)
        .set({
          status: 'FAILED_ON_RESTART',
          errorMessage: 'Process restarted (or this is a fresh process) while this run was in flight; no in-memory state existed to resume it.',
          completedAt: new Date().toISOString(),
        })
        .where(and(eq(researchAgentRuns.id, row.id), inArray(researchAgentRuns.status, NON_TERMINAL_STATUSES)));
    }
  } catch (e) {
    console.error('[ResearchAgentRunner] Failed to recover orphaned runs from a prior process:', e);
  }
}

/** Test-only: allow a test to force orphan recovery to run again within the same process. */
export function resetOrphanRecoveryForTests(): void {
  hasRecoveredOrphansThisProcess = false;
}

/**
 * Fast path: validates nothing beyond what the route already checked, recovers any orphaned runs
 * from a prior process (once), persists a PENDING row, and returns immediately. Never calls
 * LangGraph itself - see completeStrategyGraduationRun() for that.
 */
export async function beginStrategyGraduationRun(req: StrategyGraduationRunRequest): Promise<{ runId: string; correlationId: string; status: ResearchRunStatus }> {
  await recoverOrphanedResearchRunsOnce();

  const runId = uuidv4();
  const correlationId = req.correlationId || uuidv4();
  const createdAt = new Date().toISOString();
  const triggerType = req.triggerType ?? 'MANUAL';
  const triggerReason = req.triggerReason ?? null;
  const triggerEventId = req.triggerEventId ?? null;
  const evidenceSnapshotJson = req.evidenceSnapshot ? JSON.stringify(req.evidenceSnapshot) : null;

  if (!tryAcquireRunSlot()) {
    // At capacity right now - recorded as a real, auditable attempt rather than silently dropped,
    // but never started (no LangGraph call, no slot consumed for a run that was never going to run).
    try {
      await db.insert(researchAgentRuns).values({
        id: runId,
        correlationId,
        kind: 'STRATEGY_GRADUATION_RECOMMENDATION',
        strategyId: req.strategyId,
        requestJson: JSON.stringify({ strategyId: req.strategyId }),
        status: 'FAILED',
        errorMessage: `MAX_CONCURRENCY_REACHED: ${langGraphResearch.maxConcurrentRuns} run(s) already in flight.`,
        createdAt,
        completedAt: createdAt,
        triggerType,
        triggerReason,
        triggerEventId,
        evidenceSnapshotJson,
      });
    } catch (e) {
      console.error('[ResearchAgentRunner] Failed to persist MAX_CONCURRENCY_REACHED run row:', e);
    }
    return { runId, correlationId, status: 'FAILED' };
  }

  try {
    await db.insert(researchAgentRuns).values({
      id: runId,
      correlationId,
      kind: 'STRATEGY_GRADUATION_RECOMMENDATION',
      strategyId: req.strategyId,
      requestJson: JSON.stringify({ strategyId: req.strategyId }),
      status: 'PENDING',
      createdAt,
      triggerType,
      triggerReason,
      triggerEventId,
      evidenceSnapshotJson,
    });
  } catch (e) {
    console.error('[ResearchAgentRunner] Failed to persist PENDING run row:', e);
    releaseRunSlot(); // never started - the slot this reserved must not leak
  }

  return { runId, correlationId, status: 'PENDING' };
}

/**
 * Slow path: the real LangGraph call + persistence. Intended to be called detached
 * (`void completeStrategyGraduationRun(...)`) by the HTTP route so its latency never blocks (or
 * races the timeout of) the response `beginStrategyGraduationRun` already sent. Never throws -
 * every failure mode is caught and persisted as a terminal status, never left dangling.
 *
 * Every write here is a conditional UPDATE guarded by the run's current status still being
 * PENDING/RUNNING - if `cancelResearchRun` already marked this run CANCELLED (or, in principle, a
 * second call somehow raced this one), this becomes a real no-op against an already-terminal row
 * rather than overwriting it. This is what makes completion idempotent.
 */
export async function completeStrategyGraduationRun(runId: string, correlationId: string, strategyId: string): Promise<StrategyGraduationRunOutcome> {
  const startedAt = new Date().toISOString();
  try {
    await db.update(researchAgentRuns)
      .set({ status: 'RUNNING', startedAt })
      .where(and(eq(researchAgentRuns.id, runId), inArray(researchAgentRuns.status, NON_TERMINAL_STATUSES)));
  } catch (e) {
    console.error('[ResearchAgentRunner] Failed to persist RUNNING transition:', e);
  }

  let outcome: LangGraphResearchOutcome;
  try {
    outcome = await langGraphResearchService.requestStrategyGraduationRecommendation(strategyId, correlationId);
  } finally {
    releaseRunSlot();
  }

  const completedAt = new Date().toISOString();
  let status: ResearchRunStatus;
  let resultJson: string | null = null;
  let errorMessage: string | null = null;
  let graphVersion: string | null = null;
  let providerModel: string | null = null;
  let durationMs: number | null = null;

  if (outcome.ok === true) {
    const envelope = outcome.envelope;
    graphVersion = envelope.graphVersion;
    providerModel = envelope.providerModel;
    durationMs = envelope.durationMs;
    if (envelope.status === 'FAILED') {
      status = 'FAILED';
      errorMessage = envelope.error;
    } else {
      status = 'COMPLETED';
      resultJson = JSON.stringify(envelope.result);
    }
  } else {
    // Distinct TIMEOUT status (rather than folding it into the generic UNAVAILABLE bucket) - a
    // real, useful refinement: a client watching run status can tell "the companion never
    // answered in time" apart from "the companion is down/disabled/returned garbage".
    const failure = outcome as { ok: false; reason: string; detail?: string };
    status = failure.reason === 'TIMEOUT' ? 'TIMEOUT' : 'UNAVAILABLE';
    errorMessage = `${failure.reason}${failure.detail ? `: ${failure.detail}` : ''}`;
  }

  try {
    await db.update(researchAgentRuns)
      .set({ status, resultJson, errorMessage, graphVersion, providerModel, durationMs, completedAt })
      .where(and(eq(researchAgentRuns.id, runId), inArray(researchAgentRuns.status, NON_TERMINAL_STATUSES)));
  } catch (e) {
    console.error('[ResearchAgentRunner] Failed to persist completed run row:', e);
  }

  return { runId, correlationId, status, outcome };
}

/**
 * Best-effort cancellation: marks a PENDING/RUNNING run CANCELLED. Cannot interrupt an in-flight
 * HTTP call already sent to the LangGraph companion (no cancellation token exists on that
 * transport), but it does two real things: (1) it wins the race against
 * completeStrategyGraduationRun's own conditional UPDATE, so a result that arrives after
 * cancellation is never written over the CANCELLED status; (2) it gives a human-visible,
 * auditable record that cancellation was requested. Returns false (no-op) if the run is already
 * terminal - cancelling an already-finished run is never an error, just a no-op.
 */
export async function cancelResearchRun(runId: string): Promise<{ cancelled: boolean }> {
  try {
    const result = await db.update(researchAgentRuns)
      .set({ status: 'CANCELLED', errorMessage: 'Cancelled by operator request.', completedAt: new Date().toISOString() })
      .where(and(eq(researchAgentRuns.id, runId), inArray(researchAgentRuns.status, NON_TERMINAL_STATUSES)));
    const changes = (result as unknown as { changes?: number })?.changes ?? 0;
    return { cancelled: changes > 0 };
  } catch (e) {
    console.error('[ResearchAgentRunner] Failed to cancel run:', e);
    return { cancelled: false };
  }
}

/**
 * Synchronous convenience wrapper (begin, then await complete) - kept for the one caller that
 * wants this behavior on purpose (existing tests that mock this function directly; any future
 * non-HTTP caller, e.g. a script, that genuinely wants to block until done). The HTTP route no
 * longer uses this - see researchRoutes.ts.
 */
export async function runStrategyGraduationRecommendation(req: StrategyGraduationRunRequest): Promise<StrategyGraduationRunOutcome> {
  const begun = await beginStrategyGraduationRun(req);
  if (begun.status !== 'PENDING') {
    // MAX_CONCURRENCY_REACHED - already terminal, nothing to complete.
    return { runId: begun.runId, correlationId: begun.correlationId, status: begun.status };
  }
  return completeStrategyGraduationRun(begun.runId, begun.correlationId, req.strategyId);
}
