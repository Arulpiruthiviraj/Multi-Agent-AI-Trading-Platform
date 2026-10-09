/**
 * Read-only production-state diagnostics (2026-10-08, code-only defect repair mission).
 *
 * Defect #1 follow-through: the 2026-10-08 PAPER session showed strategies with no
 * lifecycle record at all, invisible to every readiness check. This endpoint answers
 * "what would the authorization layer decide for each canonical strategy, against the
 * REAL runtime DB, right now?" using the REAL production resolver
 * (resolveQuantStrategyAuthorization) — no forked logic, no synthetic DB.
 *
 * GET /api/v2/diagnostics/quant-readiness
 *
 * Strictly read-only: performs SELECTs and pure resolution only. Never writes,
 * promotes, repairs, or seeds lifecycle state. Never arms LIVE. The per-strategy
 * verdict is computed by feeding a synthetic QUANT_STRATEGY-origin idea (agent
 * 'QuantEngine', the registered quant producer) through the same resolver the
 * ChiefTrader policy router uses in production, so the verdicts are exactly what
 * a live idea from that strategy would receive.
 *
 * Boundary: diagnostic only. Does not touch ChiefTrader/RiskEngine/OMS/BrokerManager,
 * emits no trade ideas, and never changes LIVE_NO_GO semantics.
 */
import { Router, Request, Response } from 'express';
import {
  resolveQuantStrategyAuthorization,
  type QuantAuthority,
  type QuantAuthorizationReason,
} from '../quant/QuantStrategyAuthorization';
import {
  getStrategyLifecycleStatus,
  hasStrategyLifecycleRecord,
} from '../quant/strategies/StrategyEmissionEligibility';
import { resolveStrategiesForLiveEvaluation } from '../quant/strategies/StrategyEngine';
import { isPaperTradingOnlyEnforced } from '../core/tradingModeEnv';
import { isQuantPolicyEnabled } from '../config/quantDecisionPolicy';

export const diagnosticsRouter = Router();

export interface QuantReadinessStrategyRow {
  strategyId: string;
  lifecycleRecordExists: boolean;
  lifecycleStatus: string | null;
  authority: QuantAuthority;
  reason: QuantAuthorizationReason;
  /** True when this strategy could enter QuantExecutionPolicy right now. */
  quantPolicyEligible: boolean;
}

export interface QuantReadinessReport {
  ok: true;
  readOnly: true;
  generatedAt: string;
  paperOnlyEnforced: boolean;
  quantPolicyEnabled: boolean;
  strategies: QuantReadinessStrategyRow[];
  summary: {
    total: number;
    authorizedQuantPolicy: number;
    requiresConsensus: number;
    notEligible: number;
    notAuthorizedMissingLifecycle: number;
    quantPolicyEligibleIds: string[];
  };
}

/**
 * Build the report against the live DB via the production resolver. Never throws:
 * resolveQuantStrategyAuthorization itself is fail-closed and never throws; the
 * per-strategy lifecycle reads are additionally guarded so one bad row cannot
 * hide the rest of the desk.
 */
export async function buildQuantReadinessReport(): Promise<QuantReadinessReport> {
  const paperOnlyEnforced = isPaperTradingOnlyEnforced();
  const quantPolicyEnabled = isQuantPolicyEnabled();
  const strategies: QuantReadinessStrategyRow[] = [];

  for (const def of resolveStrategiesForLiveEvaluation()) {
    const strategyId = def.id;
    let lifecycleRecordExists = false;
    let lifecycleStatus: string | null = null;
    try {
      lifecycleRecordExists = await hasStrategyLifecycleRecord(strategyId);
      lifecycleStatus = lifecycleRecordExists ? await getStrategyLifecycleStatus(strategyId) : null;
    } catch {
      // Lifecycle read failed: the resolver below will surface
      // STRATEGY_LIFECYCLE_LOOKUP_FAILED / REQUIRES_CONSENSUS for this row.
    }
    const authorization = await resolveQuantStrategyAuthorization({
      origin: 'QUANT_STRATEGY',
      strategyId,
      agent: 'QuantEngine',
    });
    strategies.push({
      strategyId,
      lifecycleRecordExists,
      lifecycleStatus,
      authority: authorization.authority,
      reason: authorization.reason,
      quantPolicyEligible: authorization.authority === 'AUTHORIZED_QUANT_POLICY',
    });
  }

  const summary = {
    total: strategies.length,
    authorizedQuantPolicy: strategies.filter((s) => s.authority === 'AUTHORIZED_QUANT_POLICY').length,
    requiresConsensus: strategies.filter((s) => s.authority === 'REQUIRES_CONSENSUS').length,
    notEligible: strategies.filter((s) => s.authority === 'NOT_ELIGIBLE').length,
    notAuthorizedMissingLifecycle: strategies.filter((s) => s.authority === 'NOT_AUTHORIZED').length,
    quantPolicyEligibleIds: strategies
      .filter((s) => s.authority === 'AUTHORIZED_QUANT_POLICY')
      .map((s) => s.strategyId),
  };

  return {
    ok: true,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    paperOnlyEnforced,
    quantPolicyEnabled,
    strategies,
    summary,
  };
}

diagnosticsRouter.get('/quant-readiness', async (_req: Request, res: Response) => {
  try {
    res.json(await buildQuantReadinessReport());
  } catch (e: unknown) {
    res.status(500).json({
      ok: false,
      readOnly: true,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
