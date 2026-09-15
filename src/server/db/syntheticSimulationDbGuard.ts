/**
 * Mechanical isolation guard (2026-09-14, Synthetic Market Session Simulator hardening) - see
 * db/index.ts's own call site comment for the full incident this closes. Pure function,
 * deliberately separated from db/index.ts's own module-load side effects (which open a real
 * SQLite connection) so this logic can be unit-tested with fake paths, never risking the test
 * itself opening the real production database file to prove the guard works.
 */
import path from 'path';

/**
 * Throws if a synthetic simulation session's requested DB path resolves to the production
 * database path. Both paths are resolved via path.resolve() before comparison so relative-vs-
 * absolute spelling differences of the SAME file don't produce a false negative.
 */
export function assertSyntheticSimulationNotOpeningProductionDb(
  isSyntheticSimulation: boolean,
  requestedDbPath: string,
  productionDbPath: string,
): void {
  if (!isSyntheticSimulation) return;
  const resolvedRequested = path.resolve(requestedDbPath);
  const resolvedProduction = path.resolve(productionDbPath);
  if (resolvedRequested === resolvedProduction) {
    throw new Error(
      `FATAL: SYNTHETIC_SIMULATION=true but ARGUS_DB_PATH resolves to the production database ` +
      `(${resolvedProduction}). A synthetic simulation session must never open the real database. ` +
      `Refusing to connect.`,
    );
  }
}
