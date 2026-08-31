/**
 * Phase 10 (Agent Edge Discovery, 2026-08-31) - the decision-ready "why can't this agent/bucket
 * influence MODERATE right now" answer. Pure composition of already-computed, already-tested
 * signals - agentEdgeAnalytics (per-agent statistical status), calibrationMaturity (per-bucket
 * UNVALIDATED/LEARNING/CALIBRATED/TRUSTED), chronologicalEdgeValidation (OOS/walk-forward
 * consistency) - plus one new, narrow, real check (PROVIDER_UNAVAILABLE) against ai_calls.
 *
 * Read-only, observational. Never gates a trade, never imports ChiefTraderAgent/RiskEngine/OMS.
 * ELIGIBLE here means "this (agent, bucket) has real, validated, consistent, above-chance
 * evidence" - it does NOT itself approve anything; the existing MODERATE calibration-trust gate
 * (ModerateTierEvaluator.ts) remains the sole live consumer of calibration trust, and is not
 * changed by this module.
 *
 * Deliberately NOT reusing promotionEngine.ts's StrategyLifecycleStatus (UNTESTED/BACKTEST_ONLY/
 * OOS_TESTING/WALK_FORWARD_TESTING/.../VALIDATED/LIVE_APPROVED): that enum measures a genuinely
 * different evidence type - whether a named QUANT STRATEGY has cleared the historical-warehouse
 * backtest/OOS/WFO/robustness pipeline (parquet-backed, NEXT_BAR_OPEN canonical fills). This module
 * measures whether a live AGENT's real, already-graded paper/live predictions (agent_predictions +
 * prediction_outcomes) show real, consistent, above-chance accuracy. A QuantEngine idea tagged
 * "MOMENTUM_BREAKOUT" can share a name with a warehouse-backtested strategy of the same name
 * without these being the same evidence - conflating them into one lifecycle would misrepresent
 * which population each status describes. TradingEligibilityStatus is therefore its own, narrower,
 * purpose-built enum for this one question.
 */
import { db } from '../db';
import { aiCalls } from '../db/schema';
import { gte } from 'drizzle-orm';
import { buildCalibrationMaturityReport, type CalibrationMaturityRow } from '../continuous/calibrationMaturity';
import { buildAgentEdgeReport, type AgentEdgeRow } from './agentEdgeAnalytics';
import { validateAgentOutOfSample, validateAgentWalkForward } from './chronologicalEdgeValidation';

export type TradingEligibilityStatus =
  | 'ELIGIBLE'
  | 'NOT_MATURE'
  | 'NO_STATISTICAL_EDGE'
  | 'INSUFFICIENT_SAMPLE'
  | 'CALIBRATION_FAILED'
  | 'OOS_FAILED'
  | 'WALK_FORWARD_FAILED'
  | 'PROVIDER_UNAVAILABLE';

export interface AgentBucketEligibility {
  agentName: string;
  bucketLow: number;
  bucketHigh: number;
  status: TradingEligibilityStatus;
  reason: string;
}

/** An agent is PROVIDER_UNAVAILABLE right now only when it has made real AI calls recently and
 *  every one of them failed - never flagged for a deterministic agent (TechnicalAgent) that makes
 *  no AI calls at all, and never flagged just because a bucket lacks data (that is NOT_MATURE). */
async function isProviderBlocked(agentName: string, windowMs = 6 * 60 * 60 * 1000): Promise<boolean> {
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const rows = await db.select().from(aiCalls).where(gte(aiCalls.createdAt, sinceIso));
  const agentRows = rows.filter((r) => r.agent === agentName);
  if (agentRows.length === 0) return false;
  return agentRows.every((r) => r.status !== 'success');
}

export async function buildAgentTradingEligibilityReport(): Promise<AgentBucketEligibility[]> {
  const [maturityRows, edgeRows] = await Promise.all([
    buildCalibrationMaturityReport(),
    buildAgentEdgeReport(),
  ]);
  const overallEdgeByAgent = new Map(edgeRows.filter((r) => r.strategyId === null).map((r) => [r.agentName, r]));

  const agents = Array.from(new Set(maturityRows.map((r) => r.agentName)));
  const [oosByAgent, wfByAgent, providerBlockedByAgent] = await Promise.all([
    Promise.all(agents.map(async (a) => [a, await validateAgentOutOfSample(a)] as const)).then((r) => new Map(r)),
    Promise.all(agents.map(async (a) => [a, await validateAgentWalkForward(a)] as const)).then((r) => new Map(r)),
    Promise.all(agents.map(async (a) => [a, await isProviderBlocked(a)] as const)).then((r) => new Map(r)),
  ]);

  const results: AgentBucketEligibility[] = [];
  for (const bucket of maturityRows) {
    results.push(classifyBucket(bucket, overallEdgeByAgent.get(bucket.agentName), oosByAgent.get(bucket.agentName), wfByAgent.get(bucket.agentName), providerBlockedByAgent.get(bucket.agentName) ?? false));
  }
  return results;
}

function classifyBucket(
  bucket: CalibrationMaturityRow,
  edge: AgentEdgeRow | undefined,
  oos: Awaited<ReturnType<typeof validateAgentOutOfSample>> | undefined,
  wf: Awaited<ReturnType<typeof validateAgentWalkForward>> | undefined,
  providerBlocked: boolean,
): AgentBucketEligibility {
  const base = { agentName: bucket.agentName, bucketLow: bucket.bucketLow, bucketHigh: bucket.bucketHigh };

  if (providerBlocked) {
    return { ...base, status: 'PROVIDER_UNAVAILABLE', reason: `Every recent AI call for ${bucket.agentName} has failed - cannot currently produce a fresh, provider-backed evaluation.` };
  }
  if (bucket.status === 'UNVALIDATED' || bucket.status === 'LEARNING') {
    return { ...base, status: 'NOT_MATURE', reason: bucket.detail };
  }
  if (edge && edge.statisticalStatus === 'BELOW_CHANCE') {
    return { ...base, status: 'NO_STATISTICAL_EDGE', reason: `${bucket.agentName}'s overall real win rate is statistically BELOW chance (Wilson upper bound < 0.5) - negatively predictive, not merely unproven.` };
  }
  if (bucket.status === 'CALIBRATED') {
    return { ...base, status: 'CALIBRATION_FAILED', reason: bucket.detail };
  }
  // bucket.status === 'TRUSTED' from here on - check the agent-level consistency validators too.
  if (!oos || oos.status === 'INSUFFICIENT_SAMPLE' || !wf || wf.status === 'INSUFFICIENT_SAMPLE') {
    return { ...base, status: 'INSUFFICIENT_SAMPLE', reason: (oos && oos.status === 'INSUFFICIENT_SAMPLE' ? oos.reason : wf?.reason) ?? 'Insufficient chronological history to validate OOS/walk-forward consistency.' };
  }
  if (oos.status === 'OOS_FAILED') {
    return { ...base, status: 'OOS_FAILED', reason: oos.reason };
  }
  if (wf.status === 'WALK_FORWARD_FAILED') {
    return { ...base, status: 'WALK_FORWARD_FAILED', reason: wf.reason };
  }
  return { ...base, status: 'ELIGIBLE', reason: `Bucket is a statistically-validated TRUSTED champion, agent-level OOS and walk-forward consistency both pass.` };
}

export function formatAgentTradingEligibilityReport(rows: AgentBucketEligibility[]): string {
  const lines = ['TRADING ELIGIBILITY', '--------------------', 'Agent'.padEnd(24) + 'Bucket'.padEnd(12) + 'Status'.padEnd(22) + 'Reason'];
  for (const r of rows) {
    lines.push(r.agentName.padEnd(24) + `${r.bucketLow}-${r.bucketHigh}`.padEnd(12) + r.status.padEnd(22) + r.reason);
  }
  return lines.join('\n');
}
