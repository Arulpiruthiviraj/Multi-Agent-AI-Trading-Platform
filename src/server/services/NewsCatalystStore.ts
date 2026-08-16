/**
 * Module: NewsCatalystStore
 *
 * In-memory last-N news catalysts per symbol. News is evidence, not an order.
 * RiskEngine news_veto still reads news_clusters independently.
 */
export interface NewsCatalyst {
  traceId: string;
  symbol: string;
  headline: string;
  source: string;
  publishedAtMs: number | null;
  sentiment: number | null;
  credibility: number;
  catalystStrength: 'LOW' | 'MODERATE' | 'HIGH';
  tradingBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  contribution: number;
  reasoning: string;
  recordedAt: string;
}

const MAX_PER_SYMBOL = 12;
const bySymbol = new Map<string, NewsCatalyst[]>();

export function recordNewsCatalyst(catalyst: NewsCatalyst): void {
  const key = catalyst.symbol.toUpperCase();
  const list = bySymbol.get(key) ?? [];
  list.unshift(catalyst);
  bySymbol.set(key, list.slice(0, MAX_PER_SYMBOL));
}

export function getNewsCatalysts(symbol: string): NewsCatalyst[] {
  return [...(bySymbol.get(symbol.toUpperCase()) ?? [])];
}

export function listRecentNewsCatalysts(limit = 20): NewsCatalyst[] {
  const all = [...bySymbol.values()].flat();
  return all
    .sort((a, b) => (b.publishedAtMs ?? 0) - (a.publishedAtMs ?? 0))
    .slice(0, limit);
}

export function clearNewsCatalystsForTests(): void {
  bySymbol.clear();
}
