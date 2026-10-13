/**
 * Portfolio-intel helpers used by PortfolioMonitor when ARGUS_PORTFOLIO_INTEL_ENABLED=true.
 * Default off = identity. Never calls placeOrder.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { continuousIntelligence, isPortfolioIntelEnabled } from '../config/continuousIntelligence';
import { marketDataWorker } from '../services/MarketDataWorker';

export type PortfolioDecisionState =
  | 'HEALTHY'
  | 'WATCH'
  | 'WARNING'
  | 'EXIT_CANDIDATE'
  | 'NO_PRICE'
  | 'STALE_PRICE'
  | 'NO_BASIS';

const lastExitEmitAt = new Map<string, number>();
const activeExitTraceBySymbol = new Map<string, string>();

export function resetPortfolioIntelForTests() {
  lastExitEmitAt.clear();
  activeExitTraceBySymbol.clear();
}

/**
 * 2026-10-08 memory-leak hunt: drop exit-idea cooldown entries for symbols with no open
 * holding. Keys are stored upper-cased by canEmitPortfolioExitIdea, so heldSymbols must be
 * upper-cased too. Terminal-state cleanup only — a still-held symbol's cooldown is untouched,
 * and a closed position cannot emit exit ideas anyway; removing its stale entry only stops
 * the old position's cooldown from throttling a later re-entry's first exit idea.
 */
export function pruneExitCooldownsForFlatSymbols(heldSymbols: Set<string>): void {
  for (const key of [...lastExitEmitAt.keys()]) {
    if (!heldSymbols.has(key)) {
      lastExitEmitAt.delete(key);
      activeExitTraceBySymbol.delete(key);
    }
  }
}

export function ensureHoldingSubscribed(symbol: string): void {
  if (!isPortfolioIntelEnabled()) return;
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return;
  if (marketDataWorker.getActiveSymbols().map((s) => s.toUpperCase()).includes(sym)) return;
  eventBus.emit(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, {
    symbol: sym,
    source: 'PortfolioIntel',
    reason: 'OPEN_POSITION_NEEDS_TICKS',
    honesty: 'Subscribe so exits have a live price. Not an order.',
  });
}

export function canEmitPortfolioExitIdea(symbol: string, now = Date.now(), traceId?: string): boolean {
  if (!isPortfolioIntelEnabled()) return true;
  const key = symbol.toUpperCase();
  // A genuine protective attempt that reached Risk/OMS owns the symbol until a terminal
  // result releases it. This prevents a second close from being emitted merely because the
  // wall-clock cooldown elapsed while the first order is still pending/partially filled.
  if (activeExitTraceBySymbol.has(key)) return false;
  const last = lastExitEmitAt.get(key) ?? 0;
  if (now - last < continuousIntelligence.exitIdeaCooldownMs) return false;
  lastExitEmitAt.set(key, now);
  if (traceId) activeExitTraceBySymbol.set(key, traceId);
  return true;
}

/**
 * 2026-10-13 safety closure: a rejected protective exit must not remain suppressed for the
 * generic five-minute idea cooldown. Release only the exact trace that currently owns the
 * symbol's throttle; unrelated SELLs cannot unlock it.
 */
export function releasePortfolioExitCooldownForTrace(symbol: unknown, traceId: unknown): boolean {
  if (typeof symbol !== 'string' || typeof traceId !== 'string' || !symbol || !traceId) return false;
  const key = symbol.toUpperCase();
  if (activeExitTraceBySymbol.get(key) !== traceId) return false;
  activeExitTraceBySymbol.delete(key);
  lastExitEmitAt.delete(key);
  return true;
}

// Pre-Chief rejection/rate-limit must also release ownership. emitTradeIdea can fail at the
// contract/asset/rate gate before RiskEngine ever sees the trace.
eventBus.on(EVENTS.TRADE_IDEA_REJECTED, (rejection: any) => {
  releasePortfolioExitCooldownForTrace(rejection?.symbol, rejection?.traceId);
});
eventBus.on(EVENTS.IDEA_RATE_LIMITED, (limited: any) => {
  releasePortfolioExitCooldownForTrace(limited?.symbol, limited?.traceId);
});

eventBus.on(EVENTS.RISK_ASSESSMENT_COMPLETED, (assessment: any) => {
  if (assessment?.approved === false) {
    releasePortfolioExitCooldownForTrace(assessment.symbol, assessment.traceId);
  }
});

// ChiefTrader terminal NO_TRADE for this exact trace (consensus/quant-policy rejection) also ends the attempt.
eventBus.on(EVENTS.DESK_NO_TRADE, (noTrade: any) => {
  releasePortfolioExitCooldownForTrace(noTrade?.symbol, noTrade?.traceId);
});

eventBus.on(EVENTS.RISK_BLOCK, (block: any) => {
  releasePortfolioExitCooldownForTrace(block?.symbol, block?.traceId);
});

eventBus.on(EVENTS.ORDER_EXECUTED, (order: any) => {
  const status = String(order?.status ?? '').toUpperCase();
  if (status === 'FILLED' || status === 'REJECTED' || status === 'CANCELED') {
    releasePortfolioExitCooldownForTrace(order?.symbol, order?.traceId);
  }
});

export type ExitOwnerOrderState = 'NONE' | 'NON_TERMINAL' | 'TERMINAL';

/**
 * Backstop for a lost terminal event. Ownership normally ends on an explicit terminal signal for the exact
 * trace; if that signal never arrives (idea swallowed before OMS, crash between Risk and OMS) the symbol would
 * stay single-flight forever with an unprotected position. Evidence-based, not a timer: a trace whose order is
 * live (NON_TERMINAL) is NEVER released here, however old; a TERMINAL order releases; no order row at all
 * releases only after exitOwnershipOrphanGraceMs.
 */
export function reconcileExitOwnership(symbol: string, orderState: ExitOwnerOrderState, now = Date.now()): 'RELEASED' | 'KEPT' | 'NOT_OWNED' {
  const key = symbol.toUpperCase();
  const trace = activeExitTraceBySymbol.get(key);
  if (!trace) return 'NOT_OWNED';
  if (orderState === 'NON_TERMINAL') return 'KEPT';
  if (orderState === 'NONE') {
    const emittedAt = lastExitEmitAt.get(key) ?? 0;
    if (now - emittedAt < continuousIntelligence.exitOwnershipOrphanGraceMs) return 'KEPT';
  }
  releasePortfolioExitCooldownForTrace(key, trace);
  return 'RELEASED';
}

export function getExitOwnerTrace(symbol: string): string | null {
  return activeExitTraceBySymbol.get(symbol.toUpperCase()) ?? null;
}

export function recordPortfolioDecision(payload: {
  symbol: string;
  state: PortfolioDecisionState;
  pnlPct?: number;
  reason: string;
  currentPrice?: number | null;
}): void {
  if (!isPortfolioIntelEnabled()) return;
  eventBus.emit(EVENTS.PORTFOLIO_DECISION_RECORDED, {
    ...payload,
    at: new Date().toISOString(),
    honesty: 'Decision telemetry only. Executable SELL still requires emitTradeIdea → RiskEngine → OMS.',
  });
}
