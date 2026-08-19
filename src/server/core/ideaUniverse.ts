/**
 * Symbols idea agents should analyze. Follows the live IEX subscription set so discovery
 * candidates enter the same pipeline. Falls back to US benchmarks when the worker has none yet.
 */
import { marketDataWorker } from '../services/MarketDataWorker';
import { MARKET_REGISTRY } from '../markets/MarketRegistry';

export function usBenchmarkSymbols(): string[] {
  const benches = MARKET_REGISTRY.markets?.US?.benchmarks;
  return Array.isArray(benches) ? benches.filter((s) => typeof s === 'string' && s.length > 0) : [];
}

export function resolveIdeaUniverse(): string[] {
  const active = marketDataWorker.getActiveSymbols();
  if (active.length > 0) return active;
  return usBenchmarkSymbols();
}
