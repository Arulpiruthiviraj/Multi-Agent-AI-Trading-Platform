import { loadRepoConfigJson } from '../config/loadRepoConfigJson';

export interface Listing {
  exchange: string;
  market: 'US' | 'CA' | string;
  currency: 'USD' | 'CAD' | string;
}

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
  suffixToExchange: Record<string, Listing>;
  defaultListing: Listing;
  rsiScanDefaultSymbols: string[];
  rsiScanUnavailableSymbols: string[];
}

const file = loadRepoConfigJson<MarketsFile>('markets.json');

if (!Array.isArray(file.rsiScanDefaultSymbols) || file.rsiScanDefaultSymbols.some((s) => typeof s !== 'string')) {
  throw new Error('config/markets.json missing rsiScanDefaultSymbols string array');
}
if (!Array.isArray(file.rsiScanUnavailableSymbols) || file.rsiScanUnavailableSymbols.some((s) => typeof s !== 'string')) {
  throw new Error('config/markets.json missing rsiScanUnavailableSymbols string array');
}

export const MARKET_REGISTRY = file;

/** Parse ticker suffixes such as SHOP.TO / ABC.V. Bare tickers default to US/USD. */
export function resolveListing(symbol: string): Listing {
  const raw = (symbol || '').trim().toUpperCase();
  const dot = raw.lastIndexOf('.');
  if (dot > 0 && dot < raw.length - 1) {
    const suffix = raw.slice(dot + 1);
    const mapped = file.suffixToExchange[suffix];
    if (mapped) return { ...mapped };
  }
  return { ...file.defaultListing };
}

export function isCanadianListing(symbol: string): boolean {
  return resolveListing(symbol).market === 'CA';
}

export function listingCurrency(symbol: string): string {
  return resolveListing(symbol).currency;
}

export function canadianAutomatedRoutingStatus(): string {
  return file.markets.CA.automatedOrderRouting;
}
