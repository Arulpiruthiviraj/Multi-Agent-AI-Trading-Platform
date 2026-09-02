/**
 * Real reliability gap found during the 2026-09-02 forensic-audit follow-up (Phase 27/K of
 * docs/audits/ARGUS_PHASE18_19_UNIVERSAL_DISCOVERY_RESEARCH.md): the discovery scanners
 * (MarketUniverseScanner.ts and, prospectively, MomentumUniverseScanner.ts/SnapshotScanner.ts) call
 * Alpaca via a bare timeout-only fetch with no circuit breaker at all - unlike AlpacaBroker.ts's
 * own fetchAlpaca(), which already has one. If Alpaca genuinely degrades or rate-limits, these
 * scanners would keep hammering it every refresh cycle with no cooldown.
 *
 * This is a small, GENERIC circuit breaker any discovery-side HTTP caller can wrap itself with -
 * it does not touch AlpacaBroker.ts or any order-path code, and reuses the SAME reviewed threshold/
 * cooldown values (tradingSafety.alpacaCircuitBreakerFailureThreshold/CooldownMs) rather than
 * inventing new config for the identical concept. One instance per named caller (keyed by `name`)
 * so a broad-universe outage does not also trip the movers scanner's independent breaker.
 */
import { tradingSafety } from '../config/tradingSafety';

interface BreakerState {
  consecutiveFailures: number;
  openUntilMs: number;
}

const breakers = new Map<string, BreakerState>();

function stateFor(name: string): BreakerState {
  let s = breakers.get(name);
  if (!s) {
    s = { consecutiveFailures: 0, openUntilMs: 0 };
    breakers.set(name, s);
  }
  return s;
}

export class DiscoveryCircuitOpenError extends Error {
  constructor(name: string, openUntilMs: number) {
    super(`[${name}] discovery HTTP circuit breaker open until ${new Date(openUntilMs).toISOString()} - too many consecutive failures`);
    this.name = 'DiscoveryCircuitOpenError';
  }
}

/**
 * Wrap a real HTTP call with the named circuit breaker. Throws DiscoveryCircuitOpenError
 * immediately (never attempts the real call) while the breaker is open - the caller's existing
 * try/catch (every scanner already has one per batch/call) treats this exactly like any other
 * failure: logs it, excludes the affected candidates, never assumes they passed.
 */
export async function withDiscoveryCircuitBreaker<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const state = stateFor(name);
  if (Date.now() < state.openUntilMs) {
    throw new DiscoveryCircuitOpenError(name, state.openUntilMs);
  }
  try {
    const result = await fn();
    state.consecutiveFailures = 0;
    return result;
  } catch (e) {
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= tradingSafety.alpacaCircuitBreakerFailureThreshold) {
      state.openUntilMs = Date.now() + tradingSafety.alpacaCircuitBreakerCooldownMs;
    }
    throw e;
  }
}

export function resetDiscoveryCircuitBreakersForTests(): void {
  breakers.clear();
}
