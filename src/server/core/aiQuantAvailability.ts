/**
 * ==========================================================
 * Module: core/aiQuantAvailability
 *
 * Purpose:
 * Formalizes the AI_HEALTHY/AI_DEGRADED/AI_UNAVAILABLE and QUANT_HEALTHY/QUANT_DEGRADED/
 * QUANT_UNAVAILABLE state machines from docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md
 * §10 (Phase 6). Pure, read-only observability — this module does not gate, throttle, or influence
 * ChiefTrader/RiskEngine/OMS in any way; it only labels state that other code already computes.
 *
 * A real investigation before writing this (tracing AIRouter.routeConsensus()'s own internal
 * filterRoutableProviders()/isKnownDead health-sort logic) found that the "partial AI degradation
 * causes an unnecessary fail-closed HOLD" gap flagged earlier in this session's audit was WRONG —
 * routeConsensus() already excludes known-unhealthy providers before fanning out, and only the
 * ChiefTraderAgent.ts's own pushDebateFailClosed() fires when providers already deemed routable
 * genuinely fail at call time (a real signal, not a known-unhealthy artifact). That earlier
 * "gap" is corrected here rather than "fixed" with an unnecessary change to consensus-critical
 * code — see this module's own tests for the reasoning trail.
 * ==========================================================
 */
import { getAIProviderHealthSnapshot } from '../ai/AIProviderHealthCheck';
import { quantCoreBridge } from '../services/QuantCoreBridge';
import { isQuantJavaCoreEnabled } from '../config/tradingSafety';

export type AiAvailabilityState = 'AI_HEALTHY' | 'AI_DEGRADED' | 'AI_UNAVAILABLE';
export type QuantAvailabilityState = 'QUANT_HEALTHY' | 'QUANT_DEGRADED' | 'QUANT_UNAVAILABLE';

export interface AiAvailabilitySnapshot {
  state: AiAvailabilityState;
  healthyProviderCount: number;
  registeredProviderCount: number;
  statuses: Record<string, number>;
}

export interface QuantAvailabilitySnapshot {
  state: QuantAvailabilityState;
  javaEnabled: boolean;
  javaConnected: boolean | null; // null when javaEnabled is false - "not applicable", never fabricated
  detail?: string;
}

/**
 * AI_UNAVAILABLE: zero providers registered, or zero currently healthy — matches
 * AIRouter.hasAnyRoutableProvider()'s own real filter (reused indirectly via
 * getAIProviderHealthSnapshot(), not re-implemented here).
 * AI_DEGRADED: at least one healthy, but not all registered providers are.
 * AI_HEALTHY: every registered provider reports HEALTHY.
 */
export async function computeAiAvailability(): Promise<AiAvailabilitySnapshot> {
  const snapshot = await getAIProviderHealthSnapshot();
  const total = snapshot.length;
  const healthy = snapshot.filter((p) => p.status === 'HEALTHY').length;
  const statuses: Record<string, number> = {};
  for (const p of snapshot) {
    statuses[p.status] = (statuses[p.status] ?? 0) + 1;
  }

  let state: AiAvailabilityState;
  if (total === 0 || healthy === 0) {
    state = 'AI_UNAVAILABLE';
  } else if (healthy < total) {
    state = 'AI_DEGRADED';
  } else {
    state = 'AI_HEALTHY';
  }

  return { state, healthyProviderCount: healthy, registeredProviderCount: total, statuses };
}

/**
 * QUANT_HEALTHY covers both "Java disabled/off" and "Java enabled and reachable" — deliberately,
 * because TS's own StrategyEngine.ts (the 5 CORE + 16 experimental strategies) has zero dependency
 * on the Java process being up (confirmed by direct source read, ADR §1.F/§9): QuantSignalAgent's
 * evaluateAll() runs entirely on TS-computed features regardless of Java's state. Java going down
 * only removes the two narrow, already-optional Sept-9 overrides and the shadow-comparison
 * logging — it never removes quantitative evidence-generation capability itself.
 *
 * QUANT_DEGRADED: Java is enabled but a live health check reports unreachable — real degradation
 * of the Java-sourced overrides/shadow path, not of TS's own capability.
 *
 * QUANT_UNAVAILABLE is intentionally never returned by this function. A genuine "TS StrategyEngine
 * itself is broken" signal (a code exception inside evaluateAll(), not a data/network issue) is not
 * something this pass built detection for — returning it here without a real signal behind it
 * would be exactly the fabricated-evidence pattern this codebase's own discipline forbids. Any
 * future caller with a real TS-side failure signal should extend this function, not synthesize the
 * state without one.
 *
 * BUG FOUND AND FIXED 2026-09-10 (live, on a fresh engine restart): this originally called
 * quantCoreBridge.cachedHealth() — a passive cache that nothing refreshes in the background
 * (confirmed: exactly one call site for quantCoreBridge.health() anywhere in src/, an on-demand
 * route handler, no periodic keeper). On a freshly-booted process that route hadn't been hit yet,
 * so cachedHealth() was still at its constructor default (connected:false, detail:"never checked")
 * even though the Java process was independently confirmed reachable moments later by a different
 * code path (the CLI's own quant-core check). A stale-cache false QUANT_DEGRADED reading is exactly
 * the kind of misleading observability this module exists to prevent — now calls health() directly
 * for a real live check every time, bounded by the same request timeout/circuit-breaker
 * quantCoreBridge.health() already enforces, never a passive read.
 */
export async function computeQuantAvailability(): Promise<QuantAvailabilitySnapshot> {
  const javaEnabled = isQuantJavaCoreEnabled();
  if (!javaEnabled) {
    return { state: 'QUANT_HEALTHY', javaEnabled: false, javaConnected: null, detail: 'QUANT_JAVA_CORE_ENABLED is false - TS StrategyEngine unaffected' };
  }
  const health = await quantCoreBridge.health();
  if (health.connected) {
    return { state: 'QUANT_HEALTHY', javaEnabled: true, javaConnected: true };
  }
  return { state: 'QUANT_DEGRADED', javaEnabled: true, javaConnected: false, detail: health.detail };
}
