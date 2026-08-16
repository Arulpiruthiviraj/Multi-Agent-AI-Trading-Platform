/**
 * Canadian market metadata for research/readiness. Does not unlock IBKR/Questrade execution.
 */
import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

interface MarketsFile {
  markets: Record<string, {
    id: string;
    currency: string;
    timezone: string;
    exchanges: string[];
    benchmarks: string[];
    automatedOrderRouting: string;
    notes?: string;
  }>;
  suffixToExchange: Record<string, { exchange: string; market: string; currency: string }>;
}

const markets = loadRepoConfigJson<MarketsFile>('markets.json');

export function canadianMarketReadiness() {
  const ca = markets.markets.CA;
  return {
    liveExecution: 'NOT_AVAILABLE' as const,
    banner: 'CANADIAN LIVE EXECUTION: NOT AVAILABLE',
    market: ca,
    exchanges: ca.exchanges,
    currency: ca.currency,
    timezone: ca.timezone,
    symbolSuffixes: markets.suffixToExchange,
    routing: ca.automatedOrderRouting,
    why: 'IIROC 3200A.1(b)(i) and unverified IBKR/Questrade order path. Questrade placeOrder throws. IBKR canadianEquities is false.',
    impact: 'TSX/TSXV/CSE symbols must not be auto-routed. Research/backtest metadata may still be shown.',
    howToFix: 'Do not flip canadianEquities to true. Verify a legally permitted API path, 2FA, and exchange permissions first.',
  };
}
