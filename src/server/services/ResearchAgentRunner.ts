/**
 * ==========================================================
 * ResearchAgentRunner.ts
 *
 * Node-side orchestration for the isolated LangGraph research service
 * (docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md). This is the ONLY place a LangGraph result is
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
 * ==========================================================
 */
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { researchAgentRuns } from '../db/schema';
import { langGraphResearchService, type LangGraphResearchOutcome } from './LangGraphResearchService';

export interface StrategyGraduationRunRequest {
  strategyId: string;
  correlationId?: string;
}

export interface StrategyGraduationRunOutcome {
  runId: string;
  correlationId: string;
  status: 'COMPLETED' | 'FAILED' | 'UNAVAILABLE';
  outcome: LangGraphResearchOutcome;
}

/**
 * Runs exactly one strategy-graduation-recommendation request and persists the outcome
 * (including an unavailable/disabled/timeout outcome - the ledger is honest about failures, not
 * only successes). Never throws - a persistence failure is caught and logged, never allowed to
 * propagate into whatever called this (e.g. a CLI command, a future read-only route).
 */
export async function runStrategyGraduationRecommendation(req: StrategyGraduationRunRequest): Promise<StrategyGraduationRunOutcome> {
  const runId = uuidv4();
  const correlationId = req.correlationId || uuidv4();
  const createdAt = new Date().toISOString();
  const requestJson = JSON.stringify({ strategyId: req.strategyId });

  try {
    await db.insert(researchAgentRuns).values({
      id: runId,
      correlationId,
      kind: 'STRATEGY_GRADUATION_RECOMMENDATION',
      strategyId: req.strategyId,
      requestJson,
      status: 'PENDING',
      createdAt,
    });
  } catch (e) {
    console.error('[ResearchAgentRunner] Failed to persist PENDING run row:', e);
  }

  const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation(req.strategyId, correlationId);
  const completedAt = new Date().toISOString();

  let status: 'COMPLETED' | 'FAILED' | 'UNAVAILABLE';
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
    status = 'UNAVAILABLE';
    const unavailable = outcome as { ok: false; reason: string; detail?: string };
    errorMessage = `${unavailable.reason}${unavailable.detail ? `: ${unavailable.detail}` : ''}`;
  }

  try {
    await db.update(researchAgentRuns)
      .set({ status, resultJson, errorMessage, graphVersion, providerModel, durationMs, completedAt })
      .where(eq(researchAgentRuns.id, runId));
  } catch (e) {
    console.error('[ResearchAgentRunner] Failed to persist completed run row:', e);
  }

  return { runId, correlationId, status, outcome };
}
