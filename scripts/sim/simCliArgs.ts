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
 * The two (agent, bucket) pairs found, by direct inspection of a real VALIDATED_CONVERGENCE_CONTROL
 * run's own agent_predictions/kronos_predictions rows, to be the ones ChiefTrader's real MODERATE-
 * tier calibration-trust check needed for SPY's genuine 2-independent-agent SELL agreement
 * (JavaCoreEnsemble raw confidence 0.65, KronosEngine raw confidence 0.818) - see
 * CalibrationHistorySeeder.ts's own header for the full disclosure this represents.
 */
export const DEFAULT_CALIBRATION_SEEDS: CalibrationSeedSpec[] = [
  { agentName: 'JavaCoreEnsemble', bucketLow: 0.6, bucketHigh: 0.7 },
  { agentName: 'KronosEngine', bucketLow: 0.8, bucketHigh: 0.9 },
];

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
