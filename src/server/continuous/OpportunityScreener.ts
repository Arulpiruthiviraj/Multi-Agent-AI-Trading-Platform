/**
 * Optional Level-3 screener. Cheap price-return rank only.
 * May emitTradeIdea as agent OpportunityScreener (one vote). Never places orders.
 * Default OFF: ARGUS_OPPORTUNITY_IDEAS_ENABLED.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { generateTraceId } from '../core/traceId';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import {
  continuousIntelligence,
  isOpportunityIdeasEnabled,
} from '../config/continuousIntelligence';
import { markCandidatePromoted, upsertCandidate } from './candidateLifecycle';
import { recordCandidate } from '../core/recentCandidateRegistry';

export interface ScreenerTickResult {
  emitted: boolean;
  reason: string;
  symbol: string | null;
}

const priceHistory: Record<string, number[]> = {};
const lastEvaluatedAt: Record<string, number> = {};
/** Last accepted tick time per symbol - drives the idle eviction below. */
const lastTickAtMs: Record<string, number> = {};
/**
 * 2026-10-08 leak-hunt: priceHistory/lastEvaluatedAt were keyed per symbol with no eviction -
 * every distinct symbol ever ticked stayed forever (the per-symbol arrays were already capped
 * at screenerMinHistoryBars, but the KEY SET grew without bound). MARKET_DATA only ticks
 * subscribed symbols (capped by maxActiveSubscriptions), so a 1000-symbol cap is ~10x headroom:
 * live behavior is untouched, and an evicted-then-returning symbol simply re-warms exactly
 * like a fresh symbol. Engineering bound, not an operational threshold.
 */
const MAX_TRACKED_SYMBOLS = 1000;
let listening = false;

export function resetOpportunityScreenerForTests(): void {
  for (const k of Object.keys(priceHistory)) delete priceHistory[k];
  for (const k of Object.keys(lastEvaluatedAt)) delete lastEvaluatedAt[k];
  for (const k of Object.keys(lastTickAtMs)) delete lastTickAtMs[k];
}

/** Test-only: number of distinct symbols currently holding screener history (leak-hunt). */
export function getOpportunityScreenerTrackedSymbolCountForTests(): number {
  return Object.keys(priceHistory).length;
}

/** Evict least-recently-ticked symbols down to MAX_TRACKED_SYMBOLS. */
function evictIdleScreenerSymbols(): void {
  const keys = Object.keys(priceHistory);
  if (keys.length <= MAX_TRACKED_SYMBOLS) return;
  const ordered = keys.sort((a, b) => (lastTickAtMs[a] ?? 0) - (lastTickAtMs[b] ?? 0));
  for (const k of ordered.slice(0, keys.length - MAX_TRACKED_SYMBOLS)) {
    delete priceHistory[k];
    delete lastEvaluatedAt[k];
    delete lastTickAtMs[k];
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function considerScreenerTick(
  data: { symbol: string; price: number },
  now: number = Date.now(),
): ScreenerTickResult {
  const symbol = looksLikeListedTicker(data.symbol);
  if (!symbol) return { emitted: false, reason: 'INVALID_SYMBOL', symbol: null };
  if (!isOpportunityIdeasEnabled()) return { emitted: false, reason: 'FLAG_OFF', symbol };
  if (!isLiveIdeaGenerationEnabled()) return { emitted: false, reason: 'IDEA_GENERATION_GATED', symbol };
  if (!Number.isFinite(data.price) || data.price <= 0) {
    return { emitted: false, reason: 'INVALID_PRICE', symbol };
  }

  const maxBars = continuousIntelligence.screenerMinHistoryBars;
  const hist = priceHistory[symbol] || [];
  hist.push(data.price);
  while (hist.length > maxBars) hist.shift();
  priceHistory[symbol] = hist;

  if (hist.length < maxBars) {
    upsertCandidate({ symbol, state: 'WATCHING', reason: 'warming', now });
    return { emitted: false, reason: 'WARMUP', symbol };
  }

  const last = lastEvaluatedAt[symbol] || 0;
  if (now - last < continuousIntelligence.screenerEvalCooldownMs) {
    return { emitted: false, reason: 'COOLDOWN', symbol };
  }
  lastEvaluatedAt[symbol] = now;

  const first = hist[0];
  const ret = (data.price - first) / first;
  if (ret < continuousIntelligence.screenerMinReturnPct) {
    upsertCandidate({ symbol, state: 'WATCHING', reason: 'return_below_threshold', now });
    return { emitted: false, reason: 'RETURN_BELOW_THRESHOLD', symbol };
  }

  const confidence = clamp01(0.35 + ret * 4);
  const traceId = generateTraceId(symbol);
  eventBus.emitTradeIdea({
    traceId,
    symbol,
    side: 'BUY',
    confidence,
    currentPrice: data.price,
    reasoning: `OpportunityScreener rank: ${maxBars}-tick return ${(ret * 100).toFixed(2)}%. One vote, not consensus.`,
    agent: 'OpportunityScreener',
    // Phase 3 idea provenance (tradeIdeaProvenance.ts): descriptive origin only - never authoritative.
    origin: 'EXPERIMENTAL',
    timeframe: 'intraday_ticks',
    strategy: 'OPPORTUNITY_SCREENER_RETURN',
    dataFreshnessMs: 0,
    evidence: { returnPct: ret, bars: hist.length },
  });
  markCandidatePromoted(symbol, now);
  // Phase 9 (same-candidate convergence): a real, cheap-screened momentum candidate (this whole
  // function's own real tick-return calculation above) is exactly the "worth a look" signal
  // Fundamental/MacroAgent's priority round-robin already consults from Technical/Quant/
  // OpportunityDiscovery - bridging it here unifies all four real candidate sources.
  recordCandidate(symbol, now);
  return { emitted: true, reason: 'EMITTED', symbol };
}

const onMarketData = (data: { symbol: string; price: number }) => {
  considerScreenerTick(data);
};

export class OpportunityScreenerWorker {
  start() {
    if (listening) return;
    eventBus.subscribe(EVENTS.MARKET_DATA, onMarketData);
    listening = true;
    const on = isOpportunityIdeasEnabled();
    console.log(`[OpportunityScreener] Listening. Ideas ${on ? 'ARMED' : 'idle (ARGUS_OPPORTUNITY_IDEAS_ENABLED not true)'}. Never calls placeOrder.`);
  }

  stop() {
    if (!listening) return;
    eventBus.unsubscribe(EVENTS.MARKET_DATA, onMarketData);
    listening = false;
  }
}

export const opportunityScreenerWorker = new OpportunityScreenerWorker();
