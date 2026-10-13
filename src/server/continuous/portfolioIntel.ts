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
const lastExitTraceBySymbol = new Map<string, string>();
let riskListenerInstalled = false;

export function resetPortfolioIntelForTests() {
  lastExitEmitAt.clear();
  lastExitTraceBySymbol.clear();
}

/**
 * 2026-10-13 (S protective exit): a protective SELL rejected by RiskEngine at 09:14 (premarket spread 75 bps > 50)
 * was suppressed for the full 5-minute exitIdeaCooldownMs and only retried at 09:19, by which time the spread had been
 * acceptable for minutes. The cooldown exists to stop a SECOND exit idea while the first is still in flight; a
 * RiskEngine rejection means nothing is pending at the broker, so the symbol may retry after the much shorter
 * exitIdeaRejectedRetryMs (never immediately: still bounded by the 60 s monitor cadence). Approved / filled / pending
 * exits keep the full cooldown, so there is still never a duplicate exit order.
 */
export function noteExitEmission(symbol: string, traceId: string): void {
  lastExitTraceBySymbol.set(symbol.toUpperCase(), traceId);
  if (riskListenerInstalled) return;
  riskListenerInstalled = true;
  eventBus.on(EVENTS.RISK_ASSESSMENT_COMPLETED, (assessment: any) => {
    try {
      if (!assessment || assessment.approved !== false || assessment.side !== 'SELL') return;
      const key = String(assessment.symbol ?? '').toUpperCase();
      if (!key || lastExitTraceBySymbol.get(key) !== assessment.traceId) return;
      releaseExitCooldownAfterRejection(key);
    } catch { /* never let a telemetry/cooldown helper affect the risk path */ }
  });
}

export function releaseExitCooldownAfterRejection(symbol: string, now = Date.now()): void {
  const key = symbol.toUpperCase();
  const last = lastExitEmitAt.get(key);
  if (last === undefined) return;
  const earliestRetryAt = last + continuousIntelligence.exitIdeaRejectedRetryMs;
  const cooldownEnd = last + continuousIntelligence.exitIdeaCooldownMs;
  if (earliestRetryAt >= cooldownEnd) return; // retry window is not shorter than the cooldown: nothing to do
  // Re-anchor so canEmitPortfolioExitIdea() allows the next attempt exitIdeaRejectedRetryMs after the REJECTION.
  lastExitEmitAt.set(key, Math.min(last, now - (continuousIntelligence.exitIdeaCooldownMs - continuousIntelligence.exitIdeaRejectedRetryMs)));
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
