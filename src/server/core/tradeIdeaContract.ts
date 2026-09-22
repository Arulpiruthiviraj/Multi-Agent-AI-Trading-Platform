/**
 * Fail-closed contract for TRADE_IDEA_GENERATED.
 * Garbage/non-tradable symbols and missing live prices must not reach ChiefTrader.
 * RiskEngine price_validity stays fail-closed if anything slips through.
 *
 * Crypto Expansion Phase 2 (2026-09-21): migrated from looksLikeListedTicker() (equity-only) to
 * validateInstrumentSymbol() (equity path unchanged + registry-only CRYPTO branch). This is the
 * DEF-24 pre-ChiefTrader idea gate - the other real remaining blocker Phase 1 explicitly left
 * unmigrated. No caller in this codebase emits a crypto TRADE_IDEA_GENERATED event yet, so this
 * is a real but currently-unexercised capability change, not a behavior change for any live idea
 * source today.
 */
import { validateInstrumentSymbol } from './InstrumentRegistry';

export type TradeIdeaRejectReason =
  | 'INVALID_SYMBOL'
  | 'MISSING_PRICE'
  | 'NON_NUMERIC_PRICE'
  | 'NON_POSITIVE_PRICE';

export interface GatedTradeIdea {
  ok: true;
  idea: Record<string, unknown> & { symbol: string; currentPrice: number };
}

export interface RejectedTradeIdea {
  ok: false;
  reason: TradeIdeaRejectReason;
  symbol: unknown;
  currentPrice: unknown;
}

function lookupLivePrice(symbol: string): number | null {
  try {
    return livePriceLookup ? livePriceLookup(symbol) : null;
  } catch {
    return null;
  }
}

type LivePriceLookup = (symbol: string) => number | null;
let livePriceLookup: LivePriceLookup | null = null;

/** Registered by MarketDataWorker to avoid EventBus <-> MarketDataWorker import cycles. */
export function setTradeIdeaLivePriceLookup(fn: LivePriceLookup): void {
  livePriceLookup = fn;
}

function coercePositivePrice(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function gateTradeIdea(idea: any): GatedTradeIdea | RejectedTradeIdea {
  const validation = validateInstrumentSymbol(idea?.symbol);
  const ticker = validation.valid ? validation.canonicalSymbol! : null;
  if (!ticker) {
    return { ok: false, reason: 'INVALID_SYMBOL', symbol: idea?.symbol, currentPrice: idea?.currentPrice };
  }
  const attached = coercePositivePrice(idea?.currentPrice);
  const live = attached ?? lookupLivePrice(ticker);
  if (live == null) {
    if (idea?.currentPrice == null || idea?.currentPrice === '') {
      return { ok: false, reason: 'MISSING_PRICE', symbol: ticker, currentPrice: idea?.currentPrice };
    }
    if (typeof idea.currentPrice !== 'number' && typeof idea.currentPrice !== 'string') {
      return { ok: false, reason: 'NON_NUMERIC_PRICE', symbol: ticker, currentPrice: idea?.currentPrice };
    }
    return { ok: false, reason: 'NON_POSITIVE_PRICE', symbol: ticker, currentPrice: idea?.currentPrice };
  }
  return {
    ok: true,
    idea: { ...idea, symbol: ticker, currentPrice: live },
  };
}
