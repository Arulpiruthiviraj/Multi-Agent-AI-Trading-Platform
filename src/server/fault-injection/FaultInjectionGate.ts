/**
 * FAULT-INJECTION GATE — the structural guarantee that fault injection can
 * NEVER reach a production path.
 * =============================================================================
 * LABEL: FAULT_INJECTION (test-only infrastructure; see FaultInjectionGate.test.ts
 * for the machine-checked proofs).
 *
 * Every injector in this directory MUST call `assertFaultInjectionEnabled()` (or
 * be constructed through `createFaultInjectionScope()`) before arming. The gate
 * is satisfied only when the process environment carries the explicit, opt-in
 * marker:
 *
 *     ARGUS_FAULT_INJECTION=1
 *
 * Design notes (why this is structural, not a promise):
 *
 *  1. The flag defaults to ABSENT. No production entry point (server.ts,
 *     scripts/argus-engine.ts, scripts/start-headless*.ts, the watchdog, the
 *     CLI) sets it; the npm scripts that run these tests set it explicitly.
 *  2. This module is the ONLY reader of the flag in the repo. A static test
 *     (FaultInjectionGate.test.ts) scans the entire source tree and FAILS the
 *     suite if any production file (anything outside `fault-injection/**` and
 *     outside `*.test.ts`) imports from this directory or reads the flag.
 *  3. Injectors never mutate shared production singletons without registering a
 *     restoration on the scope; `disarmAll()` runs every restoration, so a test
 *     cannot leave a fault armed for a later test in the same worker.
 *  4. This module imports NOTHING from the trading path — it cannot be used to
 *     reach ChiefTrader/RiskEngine/OMS/BrokerManager. It only throws or returns.
 *
 * If you are reading this from a production incident: the gate held. Look
 * elsewhere.
 */

export const FAULT_INJECTION_ENV_VAR = 'ARGUS_FAULT_INJECTION';

export class FaultInjectionGateError extends Error {
  constructor(caller: string) {
    super(
      `[FaultInjectionGate] Refused to arm fault injector "${caller}": ` +
        `${FAULT_INJECTION_ENV_VAR} is not set to "1". Fault injection is ` +
        `test-only and structurally impossible without the explicit flag.`,
    );
    this.name = 'FaultInjectionGateError';
  }
}

/** True only when the process opted in via ARGUS_FAULT_INJECTION=1. */
export function isFaultInjectionEnabled(): boolean {
  return process.env[FAULT_INJECTION_ENV_VAR] === '1';
}

/**
 * Throws FaultInjectionGateError unless fault injection was explicitly
 * enabled. Call this FIRST in every injector factory / arming path.
 */
export function assertFaultInjectionEnabled(caller: string): void {
  if (!isFaultInjectionEnabled()) throw new FaultInjectionGateError(caller);
}
