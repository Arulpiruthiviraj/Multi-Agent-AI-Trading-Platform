/**
 * Synthetic Market Session Simulator isolation hardening (2026-09-14, Step 1). Pure, side-effect-
 * free path formula - the single source of truth for where an isolated simulation's DB and
 * session-recovery marker files live. Used by BOTH the parent launcher (scripts/sim/marketOpen.ts,
 * which must do zero Argus-module imports and therefore cannot import SyntheticSessionEngine.ts
 * itself) and SyntheticSessionEngine.prepareIsolatedEnvironment(), so the two processes can never
 * disagree about the path formula - there is exactly one place this string template is written.
 */
import path from 'node:path';
import os from 'node:os';

export interface SyntheticSimulationPaths {
  dbPath: string;
  sessionMarkerPath: string;
}

export function computeSyntheticSimulationPaths(simulationId: string): SyntheticSimulationPaths {
  return {
    dbPath: path.join(os.tmpdir(), `argus_synthetic_sim_${simulationId}.db`),
    sessionMarkerPath: path.join(os.tmpdir(), `argus_synthetic_sim_session_${simulationId}.json`),
  };
}
