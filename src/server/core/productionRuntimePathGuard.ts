/**
 * Mechanical isolation guard for Argus's runtime-identity files (2026-09-15, P1 - closes a
 * repeated incident class, not a first occurrence).
 *
 * Real incident history this closes:
 * - 2026-08-25 (enginePid.ts's own header comment): running `npm test` while a real dev engine was
 *   up repeatedly wiped the real `data/.argus_engine.pid` file out from under it, via an opt-in
 *   `ARGUS_ENGINE_PID_PATH` override a test had to remember to set. "Fixed" by adding the override -
 *   never by making the unguarded default fail loudly.
 * - 2026-09-15 (same day as this file, live-session forensic investigation): the SAME class of gap
 *   recurred for `sessionRecovery.ts`'s `data/.argus_runtime_session.json` - a full test-suite run,
 *   executed while today's real paper-trading engine (a real, live PID) was running, produced a real
 *   `UNCLEAN_SHUTDOWN_DETECTED` log line naming that exact live PID. The live engine's own file
 *   self-healed within its next 15s heartbeat and no lasting harm was found, but the isolation
 *   boundary was genuinely crossed - two incidents of the identical shape is a pattern, not a
 *   coincidence, and the fix belongs at the mechanism level, not as a third bespoke per-file patch.
 *
 * This function is the shared, fail-LOUD backstop: called at the actual read/write call site of
 * every runtime-identity file (session marker, engine PID, watchdog heartbeat), not merely
 * documented as a convention every future caller has to remember. Pure, no I/O of its own - a
 * caller that already resolved its own candidate path passes it in for one, uniform check.
 */
import path from 'path';

/**
 * True when this process is running under conditions where touching Argus's real, production
 * runtime-identity files would be a genuine incident, not a legitimate developer action:
 * - VITEST: set automatically by the Vitest runner itself (present in literally every test run,
 *   including ones that never bother to set NODE_ENV) - the most reliable, zero-configuration signal.
 * - NODE_ENV=test: the conventional signal other tooling in this repo/ecosystem already uses.
 * - SYNTHETIC_SIMULATION=true: the existing, already-reviewed flag `syntheticSimulationDbGuard.ts`
 *   uses for the exact same class of concern on the database side - reused here, not reinvented.
 */
export function isIsolationRequiredContext(): boolean {
  return process.env.VITEST === 'true'
    || process.env.NODE_ENV === 'test'
    || process.env.SYNTHETIC_SIMULATION === 'true';
}

/**
 * Throws if a resolved candidate path for a runtime-identity file matches the real production path,
 * while running under isolation-required conditions (see isIsolationRequiredContext()). Both paths
 * are resolved via path.resolve() before comparison, matching syntheticSimulationDbGuard.ts's own
 * convention, so relative-vs-absolute spelling differences of the SAME file don't produce a false
 * negative.
 *
 * Deliberately does NOT special-case "but the file doesn't exist yet" or "but this is only a read" -
 * a read of the real session/pid/heartbeat file from a test process is itself already evidence the
 * isolation boundary was not set up correctly for that test, even before any write happens.
 */
export function assertNotProductionRuntimePath(candidatePath: string, label: string, productionPath: string): void {
  if (!isIsolationRequiredContext()) return;
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedProduction = path.resolve(productionPath);
  if (resolvedCandidate === resolvedProduction) {
    throw new Error(
      `FATAL: a test/simulation process resolved ${label} to Argus's real production runtime path ` +
      `(${resolvedProduction}). A test/simulation process must never read or write this file - it is ` +
      `shared with, and actively written by, a real running production engine. Set the module's own ` +
      `*PathForTests()/*_PATH override to an isolated (e.g. os.tmpdir()) location before this module ` +
      `is used. Refusing to proceed.`,
    );
  }
}
