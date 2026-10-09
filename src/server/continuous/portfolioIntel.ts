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

export function resetPortfolioIntelForTests() {
  lastExitEmitAt.clear();
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
    if (!heldSymbols.has(key)) lastExitEmitAt.delete(key);
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

export function canEmitPortfolioExitIdea(symbol: string, now = Date.now()): boolean {
  if (!isPortfolioIntelEnabled()) return true;
  const key = symbol.toUpperCase();
  const last = lastExitEmitAt.get(key) ?? 0;
  if (now - last < continuousIntelligence.exitIdeaCooldownMs) return false;
  lastExitEmitAt.set(key, now);
  return true;
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
