/**
 * ==========================================================
 * waitForFreshMarketData.ts
 *
 * Shared, allocator-aware, bounded wait for a fresh live tick - the fix for a real defect found
 * in the September 2, 2026 forensic audit (docs/audits/ARGUS_ARCHITECTURE_AND_MARKET_DAY_FORENSIC_AUDIT_2026-09-02.md
 * section 13.1): NewsEngine.ts used to request a market-data subscription and then read
 * marketDataWorker.getLatestPrice() on the very next line, with zero wait for that subscription to
 * actually produce a tick. For a symbol outside the currently-streamed set - the exact case this
 * exists to handle - that read reliably returned null/undefined, and gateTradeIdea() correctly (but
 * consequentially) rejected the idea as MISSING_PRICE before ChiefTrader ever saw it. Confirmed
 * live: 147/147 TRADE_IDEA_REJECTED events on Sept 2 were MISSING_PRICE, ~100% attributable to
 * NewsAgent.
 *
 * This module is deliberately NOT NewsEngine-specific - any agent that reacts to a catalyst for a
 * symbol it doesn't already have a live tick for has the identical structural problem (this file's
 * fix note in NewsEngine.ts itself points at FundamentalAgent.ts's matching comment - that call
 * site was not touched in this pass; it is a documented, separately-scoped follow-up, not silently
 * fixed here).
 *
 * Safety invariants (do not weaken):
 * - Never returns a stale price (freshness re-checked against tradingSafety.stalePriceThresholdMs,
 *   the SAME bound RiskEngine's own data_freshness gate uses - no second, looser threshold).
 * - Never fabricates a price. A timeout or a denied rescue both return { ok: false }, never a
 *   substitute number.
 * - Goes through MarketDataWorker.requestTemporaryDataRescue() - the same reviewed,
 *   capacity-bounded, NEW_DATA_ACQUISITION/RENEWAL-aware allocator path every other rescue caller
 *   uses (src/server/services/MarketDataWorker.ts) - never a second, ad hoc subscription mechanism.
 * - Bounded wait only (tradingSafety.newsPriceWaitTimeoutMs, default 8s) - never an unbounded poll.
 * - Duplicate-safe: concurrent callers for the same symbol share one in-flight wait rather than
 *   starting redundant polling loops.
 * ==========================================================
 */
import { marketDataWorker } from '../services/MarketDataWorker';
import type { RescueRequestClass } from '../services/MarketDataWorker';
import { tradingSafety } from '../config/tradingSafety';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { getActiveReplaySession } from '../replay/ReplayContext';

export type WaitForFreshPriceOutcome =
  | { ok: true; price: number; alreadyFresh: boolean }
  | { ok: false; reason: 'RESCUE_DENIED'; deniedReason: string }
  | { ok: false; reason: 'TIMEOUT' }
  | { ok: false; reason: 'ERROR'; detail: string };

const inFlight = new Map<string, Promise<WaitForFreshPriceOutcome>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFreshPrice(symbol: string): number | null {
  const price = marketDataWorker.getLatestPrice(symbol);
  // Real defect found 2026-10-06 (News+Quant Independent-Consensus Round-Trip Certification):
  // MarketDataWorker.getLatestPriceAgeMs() always measures age against REAL Date.now() - it has
  // no replay/synthetic-clock awareness (a prior attempt to give it one was tried and reverted in
  // the Phase 14 historical-replay mission; see that function's own comment for why). A synthetic
  // or replay session's bar timestamps are not real wall-clock "now" by construction, so every
  // tick looked arbitrarily stale here even while flowing continuously and even while RiskEngine's
  // own gate 13 (data_freshness) was already treating the identical tick stream as fresh via its
  // established `replay ? { passed: true, priceAgeMs: 0, ... } : evaluateQuoteFreshness(...)`
  // branch ("Replay uses last completed bar at T; daily age is not live-tick staleness" -
  // RiskEngine.ts's own comment at that check). Confirmed live: every synthetic-session
  // NewsAgent idea was silently discarded as NEWS_IDEA_DISCARDED_NO_FRESH_DATA after a full
  // newsPriceWaitTimeoutMs wait, 100% of the time, regardless of how fresh the session's own
  // ticks actually were. This applies the SAME established replay-awareness RiskEngine already
  // uses, not a new or weaker rule - and it only ever WIDENS when a price counts as fresh inside
  // an active replay/synthetic session, never outside one (live/paper behavior is unchanged).
  // Always read ageMs (even when about to be ignored below) - callers/tests may rely on this call
  // happening every poll tick as part of their own bookkeeping, matching this function's pre-fix
  // behavior.
  const ageMs = marketDataWorker.getLatestPriceAgeMs(symbol);
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  if (getActiveReplaySession()) return price;
  if (typeof ageMs === 'number' && ageMs <= tradingSafety.stalePriceThresholdMs) return price;
  return null;
}

async function pollForFreshPrice(symbol: string): Promise<WaitForFreshPriceOutcome> {
  const immediate = readFreshPrice(symbol);
  if (immediate != null) return { ok: true, price: immediate, alreadyFresh: true };

  const deadline = Date.now() + tradingSafety.newsPriceWaitTimeoutMs;
  const pollMs = Math.max(25, tradingSafety.newsPriceWaitPollIntervalMs);
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const price = readFreshPrice(symbol);
    if (price != null) return { ok: true, price, alreadyFresh: false };
  }
  // One last check right at the deadline in case a tick landed during the final sleep.
  const last = readFreshPrice(symbol);
  if (last != null) return { ok: true, price: last, alreadyFresh: false };
  return { ok: false, reason: 'TIMEOUT' };
}

/**
 * Requests coverage (through the reviewed allocator, never a raw subscribe()) and waits, bounded,
 * for a fresh live tick. Never throws - every failure mode is a typed { ok: false } result.
 */
export async function waitForFreshMarketData(
  symbol: string,
  opts: { requestClass: RescueRequestClass; reason: string; traceId?: string },
): Promise<WaitForFreshPriceOutcome> {
  const existing = inFlight.get(symbol);
  const task = existing ?? (async (): Promise<WaitForFreshPriceOutcome> => {
    try {
      const rescue = marketDataWorker.requestTemporaryDataRescue(symbol, opts.reason, {
        requestClass: opts.requestClass,
        traceId: opts.traceId,
      });
      if (!rescue.granted) {
        return { ok: false, reason: 'RESCUE_DENIED', deniedReason: rescue.deniedReason ?? 'UNKNOWN' };
      }
      return await pollForFreshPrice(symbol);
    } catch (e: any) {
      // Never throws to the caller - a failure here is exactly as "no fresh data" as a timeout,
      // never a fabricated price and never an unhandled rejection surfacing at a call site that
      // didn't wrap this in its own try/catch.
      return { ok: false, reason: 'ERROR', detail: e?.message || String(e) };
    }
  })();

  if (!existing) inFlight.set(symbol, task);
  const outcome = await task;
  // Clean up after registering AND settling the task. Synchronous rescue denial
  // previously deleted before set(), caching that denial forever for this symbol.
  if (inFlight.get(symbol) === task) inFlight.delete(symbol);
  observeSafe(() => {
    const ageMs = marketDataWorker.getLatestPriceAgeMs(symbol);
    structuredLogger.info('fresh_price_wait_outcome', {
      category: 'MARKET_DATA', eventType: 'FRESH_PRICE_WAIT_OUTCOME',
      symbol, traceId: opts.traceId, requestClass: opts.requestClass,
      outcome, backend: marketDataWorker.getQuoteBackend(),
      price: marketDataWorker.getLatestPrice(symbol), quoteAgeMs: ageMs,
      lastQuoteAtMs: ageMs === null ? null : Date.now() - ageMs,
      subscription: marketDataWorker.getActiveSlots().find(s => s.symbol === symbol) ?? null,
      brokerError: marketDataWorker.getMarketDataError(symbol),
    });
  });
  return outcome;
}

/** Test-only: clear in-flight dedup state between tests. */
export function resetWaitForFreshMarketDataForTests(): void {
  inFlight.clear();
}
