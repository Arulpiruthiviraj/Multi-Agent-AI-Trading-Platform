/**
 * Operator lifecycle BASELINE (2026-10-14, explicitly authorized by the repository owner: "Baseline CORE 5 only").
 *
 * Context: since 2026-10-08 a strategy with NO learning_versions lifecycle row is terminally NOT_AUTHORIZED/NO_LIFECYCLE_RECORD and its Quant
 * ideas are dropped before consensus (QuantStrategyAuthorization). Production had zero lifecycle rows for 20 of 21 strategies, so Quant
 * produced no votes at all. The documented remedy is "an UNTESTED baseline row at minimum" (QuantStrategyAuthorization header).
 *
 * WHAT THIS GRANTS: nothing. An UNTESTED row only restores the pre-existing consensus path (0.75 bar, >= 2 independent evidence groups,
 * RiskEngine, OMS). It NEVER writes VALIDATED/CHAMPION, so no AI-independent quant execution authority is created here - that still requires
 * the evidence-gated, operator-reviewed certificationBridge.
 *
 * HARD GUARANTEES (tested):
 *  - the only status ever written is UNTESTED;
 *  - only strategies in the canonical CORE registry may be baselined (no id literals, nothing invented);
 *  - a strategy that already has ANY lifecycle row (including RETIRED/DEGRADED) is skipped, never overwritten;
 *  - a non-empty operator reason and actor are mandatory and are stored in the row's hypothesis (audit trail);
 *  - dryRun writes nothing.
 * Control-plane code: no calculations, imports no broker/OMS/RiskEngine/Chief.
 */
import { CORE_STRATEGIES } from './StrategyEngine';
import { hasStrategyLifecycleRecord, recordStrategyLifecycleTransition } from './StrategyEmissionEligibility';

export interface LifecycleBaselineRequest {
  /** Subset of CORE strategy ids; omitted = every CORE strategy that has no record. */
  strategyIds?: string[];
  reason: string;
  actor: string;
  dryRun?: boolean;
}

export interface LifecycleBaselineResult {
  dryRun: boolean;
  recorded: Array<{ strategyId: string; versionId: string | null }>;
  skipped: Array<{ strategyId: string; why: 'RECORD_EXISTS' }>;
}

export class LifecycleBaselineRefusedError extends Error {
  constructor(public readonly code: 'REASON_REQUIRED' | 'ACTOR_REQUIRED' | 'NOT_A_CORE_STRATEGY', message: string) {
    super(message);
    this.name = 'LifecycleBaselineRefusedError';
  }
}

export async function recordUntestedBaselines(req: LifecycleBaselineRequest): Promise<LifecycleBaselineResult> {
  const reason = String(req.reason ?? '').trim();
  const actor = String(req.actor ?? '').trim();
  if (reason.length < 10) throw new LifecycleBaselineRefusedError('REASON_REQUIRED', 'A reason of at least 10 characters is required for a lifecycle baseline.');
  if (!actor) throw new LifecycleBaselineRefusedError('ACTOR_REQUIRED', 'An actor is required for a lifecycle baseline.');
  const coreIds = CORE_STRATEGIES.map((s) => s.id);
  const requested = req.strategyIds && req.strategyIds.length ? [...new Set(req.strategyIds)] : coreIds;
  const foreign = requested.filter((id) => !coreIds.includes(id));
  if (foreign.length) throw new LifecycleBaselineRefusedError('NOT_A_CORE_STRATEGY', `Not a CORE strategy: ${foreign.join(', ')}`);

  const result: LifecycleBaselineResult = { dryRun: !!req.dryRun, recorded: [], skipped: [] };
  for (const strategyId of requested) {
    if (await hasStrategyLifecycleRecord(strategyId)) { result.skipped.push({ strategyId, why: 'RECORD_EXISTS' }); continue; }
    if (req.dryRun) { result.recorded.push({ strategyId, versionId: null }); continue; }
    const versionId = await recordStrategyLifecycleTransition(strategyId, 'UNTESTED', `OPERATOR_BASELINE (no authority granted): ${reason} [actor=${actor}]`, null, 0);
    result.recorded.push({ strategyId, versionId });
  }
  return result;
}
