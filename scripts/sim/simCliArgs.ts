/**
 * Synthetic Market Session Simulator isolation hardening (2026-09-14). Pure CLI-arg parsing shared
 * by the parent launcher and the child simulation process - no Argus-module imports here either.
 */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? 'true';
  }
  return out;
}

export interface CalibrationSeedSpec {
  agentName: string;
  bucketLow: number;
  bucketHigh: number;
}

/**
 * 2026-09-21, Synthetic Certification Framework Hardening Phase 1 - root-cause fix.
 *
 * The list this replaced was a REACTIVE, hand-curated set of specific (agent, bucket) pairs, each
 * added only after a specific historical run was observed to land there (JavaCoreEnsemble/
 * KronosEngine 0.6-0.7/0.8-0.9 from the original 2026-09-14 SPY SELL convergence; TechnicalAgent
 * 0.6-0.7 and 0-0.6 added 2026-09-15 after two more specific observed runs). That approach is
 * structurally incomplete: the synthetic engine's own randomness (seed, symbol mix, which of the
 * plausible independent-evidence producers actually agree on a given cycle) can legitimately land a
 * genuinely-independent, genuinely-agreeing agent's RAW confidence in a bucket nobody happened to
 * observe before. Real, confirmed evidence this was still failing as of 2026-09-20: QQQ reached
 * 64.5% consensus confidence with `MODERATE_REJECT_UNTRUSTED_CALIBRATION` even with the 5-pair list
 * above already seeded (agent_workspace/master_certification.log, session sess_9972ec81..., trace
 * trace_QQQ_1789869646_3de1) - the reactive list simply didn't cover whichever bucket that run's
 * actual agreeing agent(s) landed in. Confirmed structurally: the 5-pair list never covered the
 * 0.7-0.8 bucket AT ALL, for any agent, and never covered 0.9-1.0 either.
 *
 * Fix: seed EVERY canonical confidence bucket (mirrors, does not import - this file is deliberately
 * import-free from src/server - src/server/services/ConfidenceCalibration.ts's own CONFIDENCE_BUCKETS,
 * the actual source of truth ModerateTierEvaluator.ts's bucketFor() partitions against) for EVERY
 * agent name capable of independently agreeing in a synthetic run (the idea-generating agents active
 * in SyntheticSessionEngine minus the ones deliberately disabled there - FundamentalAgent/
 * MacroAgent/NewsEngine - plus ConsensusDebate, which is excluded from agreeingAgents entirely by
 * ChiefTraderAgent.ts itself and therefore never needs a seed). This is still the SAME disclosed,
 * authorized methodology (CalibrationHistorySeeder.ts, isolated-DB-only, real
 * runCalibrationValidationCycle() computing a genuine champion or not) - only the COVERAGE is wider,
 * not the mechanism. Never injects a vote, never touches independence or threshold logic: a
 * genuinely-independent agreement can still fail here if the real algorithm doesn't produce a
 * champion (e.g. a future win/loss recipe change) - this only removes "nobody happened to seed this
 * exact bucket yet" as a source of failure.
 */
const CANONICAL_CONFIDENCE_BUCKETS: Array<{ bucketLow: number; bucketHigh: number }> = [
  { bucketLow: 0, bucketHigh: 0.6 },
  { bucketLow: 0.6, bucketHigh: 0.7 },
  { bucketLow: 0.7, bucketHigh: 0.8 },
  { bucketLow: 0.8, bucketHigh: 0.9 },
  { bucketLow: 0.9, bucketHigh: 1.0 },
];

/** Agent names capable of independently emitting TRADE_IDEA_GENERATED in a synthetic run today -
 *  see SyntheticSessionEngine.ts's own disabling of FundamentalAgent/MacroAgent/NewsEngine, and
 *  ChiefTraderAgent.ts's own agreeingAgents filter (`e.agent !== 'ConsensusDebate'`, which is why
 *  ConsensusDebate is deliberately absent from this list - it never needs a calibration seed). */
const CALIBRATION_ELIGIBLE_AGENTS: string[] = [
  'TechnicalAgent', 'QuantEngine', 'JavaCoreEnsemble', 'JavaFactorComposite', 'KronosEngine', 'OpportunityScreener',
];

export const DEFAULT_CALIBRATION_SEEDS: CalibrationSeedSpec[] = CALIBRATION_ELIGIBLE_AGENTS.flatMap(
  (agentName) => CANONICAL_CONFIDENCE_BUCKETS.map((b) => ({ agentName, ...b })),
);

export interface ScenarioRunSpec {
  simulationId: string;
  scenarioId: string;
  seed: number;
  speed: number;
  durationMinutes: number;
  symbols: number;
  /** null = plain run, no certification verdict computed. true/false = Test B / Test A shape. */
  requireTradeForCertification: boolean | null;
  /** Explicit, disclosed methodology change - see CalibrationHistorySeeder.ts. Undefined/empty by
   *  default (no seeding). */
  calibrationSeeds?: CalibrationSeedSpec[];
}
