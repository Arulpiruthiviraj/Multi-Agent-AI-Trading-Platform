/**
 * SoakInvariants - pure evaluation of resource-growth and end-state invariants for one synthetic session (SYNTHETIC_SEEDED /
 * CERTIFICATION_FIXTURE_ONLY). A session that makes money but leaks 500 listeners or leaves a stale capital reservation is a FAILED
 * session: these invariants are about the platform staying bounded and consistent, independent of P&L.
 */
import type { ResourceSample } from './SyntheticSessionEngine';

export interface SoakBounds {
  warmupBars: number;
  maxListenerGrowth: number;
  maxTimerGrowth: number;
  maxHeapGrowthMb: number;
  maxOpenOrdersAtEnd: number;
  maxReservedNotionalAtEndUsd: number;
  maxEventLoopMaxMs: number;
}

export interface SoakFinding { code: string; detail: string }

export function evaluateSoakInvariants(
  samples: ResourceSample[],
  bounds: SoakBounds,
  extra: { eventLoopMaxMs: number | null; orphanPositions: number; unexplainedViolations: string[] },
): SoakFinding[] {
  const out: SoakFinding[] = [];
  if (samples.length < 2) { out.push({ code: 'NO_RESOURCE_SAMPLES', detail: `only ${samples.length} resource sample(s); growth cannot be evaluated` }); }
  else {
    const base = samples.find((s) => s.atBarIndex >= bounds.warmupBars) ?? samples[0];
    const end = samples[samples.length - 1];
    if (end.listenerTotal - base.listenerTotal > bounds.maxListenerGrowth) out.push({ code: 'LISTENER_GROWTH', detail: `EventBus listeners ${base.listenerTotal} -> ${end.listenerTotal} (limit +${bounds.maxListenerGrowth})` });
    if (end.activeTimers - base.activeTimers > bounds.maxTimerGrowth) out.push({ code: 'TIMER_GROWTH', detail: `active timers ${base.activeTimers} -> ${end.activeTimers} (limit +${bounds.maxTimerGrowth})` });
    if (end.heapUsedMb - base.heapUsedMb > bounds.maxHeapGrowthMb) out.push({ code: 'HEAP_GROWTH', detail: `heap ${base.heapUsedMb}MB -> ${end.heapUsedMb}MB (limit +${bounds.maxHeapGrowthMb}MB)` });
    if (end.nonTerminalOrders > bounds.maxOpenOrdersAtEnd) out.push({ code: 'OPEN_ORDERS_AT_END', detail: `${end.nonTerminalOrders} non-terminal order(s) at session end (limit ${bounds.maxOpenOrdersAtEnd})` });
    if (end.reservedNotionalUsd > bounds.maxReservedNotionalAtEndUsd) out.push({ code: 'CAPITAL_RESERVATION_LEAK', detail: `$${end.reservedNotionalUsd.toFixed(2)} still reserved at session end (limit $${bounds.maxReservedNotionalAtEndUsd})` });
  }
  if (extra.eventLoopMaxMs !== null && extra.eventLoopMaxMs > bounds.maxEventLoopMaxMs) out.push({ code: 'EVENT_LOOP_STALL', detail: `event-loop max ${extra.eventLoopMaxMs}ms (limit ${bounds.maxEventLoopMaxMs}ms)` });
  if (extra.orphanPositions > 0) out.push({ code: 'ORPHAN_POSITION', detail: `${extra.orphanPositions} position(s) not explained between broker and ledger` });
  for (const v of extra.unexplainedViolations) out.push({ code: 'TIMELINE_INVARIANT', detail: v });
  return out;
}
