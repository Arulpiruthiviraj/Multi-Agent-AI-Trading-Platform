/**
 * Isolated replay quote cache — never mutates MarketDataWorker live state.
 * FullArgusReplayEngine writes PIT decision prices here for replay-local consumers only.
 */
const replayQuotes = new Map<string, { price: number; observedAtMs: number }>();

function key(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function cacheReplayQuote(symbol: string, price: number, observedAtMs: number): void {
  const sym = key(symbol);
  if (!sym || !Number.isFinite(price) || price <= 0) return;
  replayQuotes.set(sym, { price, observedAtMs });
}

export function getReplayQuote(symbol: string): number | null {
  return replayQuotes.get(key(symbol))?.price ?? null;
}

export function getReplayQuoteAgeMs(symbol: string, nowMs: number): number | null {
  const row = replayQuotes.get(key(symbol));
  if (!row) return null;
  return Math.max(0, nowMs - row.observedAtMs);
}

export function clearReplayQuotes(): void {
  replayQuotes.clear();
}

export function replayQuoteCount(): number {
  return replayQuotes.size;
}
