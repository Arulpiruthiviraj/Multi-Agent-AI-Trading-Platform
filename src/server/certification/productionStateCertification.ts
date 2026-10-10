/**
 * Production-state certification (Layer 3), 2026-10-09.
 *
 * Why this exists: the 2026-10-09 forensic audit of the real session showed 21
 * strategies, 0 authorized Quant-policy strategies, and 20 missing lifecycle rows —
 * while every test suite was green. No pre-market check asserted the one operational
 * invariant that matters: QUANT_FIRST is only real when at least one strategy holds
 * quant-policy authority. This module certifies exactly that, against the REAL
 * production resolver, before market open.
 *
 * This module is READ-ONLY by construction: it runs the canonical
 * buildQuantReadinessReport() (src/server/routes/v2Diagnostics.ts), which performs
 * SELECTs and pure resolution only. It never writes lifecycle rows, never promotes a
 * strategy, never seeds authority, and never touches the production database
 * (callers point it at a read-only snapshot copy via ARGUS_DB_PATH).
 *
 * THE MANDATORY INVARIANT (do not weaken):
 *   AUTHORIZED_PAPER_QUANT_STRATEGIES === 0
 *     => verdict QUANT_FIRST_OPERATIONALLY_INACTIVE (FAIL)
 *     => passed === false
 *   ... EVEN IF quantPolicyEnabled === true.
 * A green quant policy switch with zero authorized strategies is exactly the
 * Oct-8/9 failure mode; reporting it PASS would re-create the blind spot.
 */
import {
  buildQuantReadinessReport,
} from '../routes/v2Diagnostics';
import type { QuantAuthorizationReason } from '../quant/QuantStrategyAuthorization';

/** Certification verdict. QUANT_FIRST_OPERATIONALLY_INACTIVE is the FAIL state. */
export type ProductionStateVerdict =
  | 'QUANT_FIRST_OPERATIONAL'
  | 'QUANT_FIRST_OPERATIONALLY_INACTIVE';

/** Per-strategy certification row. */
export interface ProductionStateStrategyDetail {
  strategyId: string;
  /**
   * True: the strategy is a member of this environment's enabled-for-live-evaluation
   * set (the exact input set of the readiness report). Reported true for every row;
   * the field exists so the row is self-describing.
   */
  enabled: boolean;
  /** True when a lifecycle decision row exists for this strategy. */
  lifecycleRecord: boolean;
  /** Latest lifecycle status, or null when no record exists. */
  lifecycleStatus: string | null;
  /** True when the canonical resolver granted AUTHORIZED_QUANT_POLICY. */
  authorized: boolean;
  /** Resolver reason (e.g. STRATEGY_VALIDATED, NO_LIFECYCLE_RECORD). */
  reason: QuantAuthorizationReason;
}

/** Counts of strategies whose latest lifecycle row carries each known status. */
export interface LifecycleStateCounts {
  ACTIVE_EXPLORATION: number;
  VALIDATED: number;
  CHAMPION: number;
  DEGRADED: number;
  RETIRED: number;
  UNTESTED: number;
  SHADOW: number;
  CANDIDATE: number;
  ROLLED_BACK: number;
}

const ZERO_STATE_COUNTS = (): LifecycleStateCounts => ({
  ACTIVE_EXPLORATION: 0,
  VALIDATED: 0,
  CHAMPION: 0,
  DEGRADED: 0,
  RETIRED: 0,
  UNTESTED: 0,
  SHADOW: 0,
  CANDIDATE: 0,
  ROLLED_BACK: 0,
});

const KNOWN_STATES = new Set<string>([
  'ACTIVE_EXPLORATION',
  'VALIDATED',
  'CHAMPION',
  'DEGRADED',
  'RETIRED',
  'UNTESTED',
  'SHADOW',
  'CANDIDATE',
  'ROLLED_BACK',
]);

/** Full production-state certification result. All fields are mandatory outputs. */
export interface ProductionStateCertification {
  /** Always true: this certification performs no writes. */
  readOnly: true;
  generatedAt: string;
  /** Strategies in the environment's live-evaluation set (canonical registry resolution). */
  TOTAL_STRATEGIES: number;
  /**
   * Strategies enabled for quant evaluation in this environment. Identical to
   * TOTAL_STRATEGIES by construction: the readiness report's input set IS the
   * resolveStrategiesForLiveEvaluation() set. Kept as a separate field because the
   * certification contract requires both numbers, and a future divergence between
   * "registered" and "enabled" must show up here, not hide.
   */
  ENABLED_QUANT_STRATEGIES: number;
  /** Strategies with at least one lifecycle decision row. */
  LIFECYCLE_ROWS: number;
  /** Strategies with no lifecycle record at all (terminally NOT_AUTHORIZED). */
  MISSING_LIFECYCLE_ROWS: number;
  /** Latest-status counts over strategies that HAVE a lifecycle row. */
  lifecycleStateCounts: LifecycleStateCounts;
  /**
   * Strategies the canonical resolver granted AUTHORIZED_QUANT_POLICY. "Paper"
   * because the resolver only grants this authority under the paper-only env lock —
   * a non-zero count with paperOnlyEnforced=false is impossible by construction.
   */
  AUTHORIZED_PAPER_QUANT_STRATEGIES: number;
  /** Master switch for the AI-independent quant decision path (config). */
  quantPolicyEnabled: boolean;
  /** Paper-only environment lock (env). */
  paperOnlyEnforced: boolean;
  verdict: ProductionStateVerdict;
  /** True only when verdict is QUANT_FIRST_OPERATIONAL. */
  passed: boolean;
  details: ProductionStateStrategyDetail[];
}

/**
 * Run the production-state certification. Read-only: delegates to the canonical
 * buildQuantReadinessReport() and aggregates — no writes, no promotions, no seeds.
 */
export async function certifyProductionState(): Promise<ProductionStateCertification> {
  const report = await buildQuantReadinessReport();

  const lifecycleStateCounts = ZERO_STATE_COUNTS();
  let lifecycleRows = 0;
  let missingLifecycleRows = 0;

  const details: ProductionStateStrategyDetail[] = report.strategies.map((s) => {
    if (s.lifecycleRecordExists) {
      lifecycleRows += 1;
      if (s.lifecycleStatus !== null && KNOWN_STATES.has(s.lifecycleStatus)) {
        lifecycleStateCounts[s.lifecycleStatus as keyof LifecycleStateCounts] += 1;
      }
    } else {
      missingLifecycleRows += 1;
    }
    return {
      strategyId: s.strategyId,
      enabled: true,
      lifecycleRecord: s.lifecycleRecordExists,
      lifecycleStatus: s.lifecycleStatus,
      authorized: s.authority === 'AUTHORIZED_QUANT_POLICY',
      reason: s.reason,
    };
  });

  const authorized = report.summary.authorizedQuantPolicy;

  // THE MANDATORY INVARIANT: zero authorized strategies means Quant-First is
  // operationally inactive — a FAIL — even when the quant policy switch is on.
  // This is the check that would have caught the Oct-8/9 gap before market open.
  const operationallyInactive = authorized === 0;

  return {
    readOnly: true,
    generatedAt: report.generatedAt,
    TOTAL_STRATEGIES: report.summary.total,
    ENABLED_QUANT_STRATEGIES: report.summary.total,
    LIFECYCLE_ROWS: lifecycleRows,
    MISSING_LIFECYCLE_ROWS: missingLifecycleRows,
    lifecycleStateCounts,
    AUTHORIZED_PAPER_QUANT_STRATEGIES: authorized,
    quantPolicyEnabled: report.quantPolicyEnabled,
    paperOnlyEnforced: report.paperOnlyEnforced,
    verdict: operationallyInactive ? 'QUANT_FIRST_OPERATIONALLY_INACTIVE' : 'QUANT_FIRST_OPERATIONAL',
    passed: !operationallyInactive,
    details,
  };
}
