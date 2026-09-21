/**
 * Market-data diagnostics report (2026-09-20, delayed-data observability follow-up).
 *
 * Read-only composition over MarketDataWorker's already-real per-symbol state
 * (marketDataLineState.ts's summarizeMarketDataLines) plus the live/delayed quote stores and the
 * IBKR contract-resolution cache. This module does not track any new state itself, does not call
 * IBKR, and cannot mutate either the live or delayed quote store - it only reads.
 *
 * Exists specifically to answer, externally and without adding per-tick logging: is IBKR actually
 * sending delayed ticks (fields 66-69) under the current entitlement/session state, and is that
 * data staying fully isolated from the live trading path. See MarketDataWorker.getDelayedQuote()'s
 * own header for why delayed data is tracked per-field (bid/ask/last/close) rather than one
 * overwriting "latest tick" slot.
 */
import { marketDataWorker } from '../services/MarketDataWorker';
import { getCachedIbkrContractResolution } from '../../brokers/ibkrContractResolution';
import { summarizeMarketDataLines, type MarketDataLineSummary, type ReadinessTriState } from '../core/marketDataLineState';

export interface SymbolMarketDataDiagnostic {
  symbol: string;
  marketDataLineState: string;
  liveQuote: { price: number; ageMs: number } | null;
  delayedQuote: {
    bid: { price: number; ageMs: number } | null;
    ask: { price: number; ageMs: number } | null;
    last: { price: number; ageMs: number } | null;
    close: { price: number; ageMs: number } | null;
    latestAgeMs: number | null;
    dataMode: 'DELAYED';
    isLive: false;
  } | null;
  latestError: { code: number; message: string; atMs: number } | null;
  contractResolution: ReadinessTriState;
  historyReady: ReadinessTriState;
  featureReady: ReadinessTriState;
}

export interface MarketDataDiagnosticsReport {
  generatedAt: string;
  summary: MarketDataLineSummary;
  symbols: SymbolMarketDataDiagnostic[];
}

/** Pure composition — every field is read, nothing is written. Safe to call at any time,
 *  including while trading is paused; has no side effects on any store. */
export function buildMarketDataDiagnosticsReport(requestedSymbols?: string[]): MarketDataDiagnosticsReport {
  const symbols = requestedSymbols && requestedSymbols.length > 0
    ? requestedSymbols.map((s) => s.toUpperCase())
    : marketDataWorker.getActiveSymbols();

  const lines = symbols.map((symbol) => {
    const resolution = getCachedIbkrContractResolution(symbol);
    const contractResolution: ReadinessTriState =
      resolution == null ? 'UNKNOWN' : resolution.status === 'RESOLVED' ? 'YES' : 'NO';
    return {
      symbol,
      contractResolution,
      input: {
        subscribedAtMs: marketDataWorker.getSubscribedAtMs(symbol),
        tickCount: marketDataWorker.getTickCount(symbol),
        latestPriceAgeMs: marketDataWorker.getLatestPriceAgeMs(symbol),
        marketDataError: marketDataWorker.getMarketDataError(symbol),
      },
    };
  });
  const summary = summarizeMarketDataLines(lines);

  const symbolDiagnostics: SymbolMarketDataDiagnostic[] = symbols.map((symbol) => {
    const livePrice = marketDataWorker.getLatestPrice(symbol);
    const liveAgeMs = marketDataWorker.getLatestPriceAgeMs(symbol);
    const delayed = marketDataWorker.getDelayedQuote(symbol);
    return {
      symbol,
      marketDataLineState: summary.bySymbol[symbol]?.state ?? 'REQUESTED',
      liveQuote: livePrice !== null && liveAgeMs !== null ? { price: livePrice, ageMs: liveAgeMs } : null,
      delayedQuote: delayed ? {
        bid: delayed.bid ? { price: delayed.bid.price, ageMs: delayed.bid.ageMs } : null,
        ask: delayed.ask ? { price: delayed.ask.price, ageMs: delayed.ask.ageMs } : null,
        last: delayed.last ? { price: delayed.last.price, ageMs: delayed.last.ageMs } : null,
        close: delayed.close ? { price: delayed.close.price, ageMs: delayed.close.ageMs } : null,
        latestAgeMs: delayed.latestAgeMs,
        dataMode: 'DELAYED',
        isLive: false,
      } : null,
      latestError: marketDataWorker.getMarketDataError(symbol),
      contractResolution: summary.bySymbol[symbol]?.contractResolution ?? 'UNKNOWN',
      // No cheap, honest per-symbol synchronous signal exists in this codebase for these two -
      // see marketDataLineState.ts's own header. UNKNOWN is the correct answer, never fabricated.
      historyReady: 'UNKNOWN',
      featureReady: 'UNKNOWN',
    };
  });

  return { generatedAt: new Date().toISOString(), summary, symbols: symbolDiagnostics };
}

export function formatMarketDataDiagnosticsReport(report: MarketDataDiagnosticsReport): string {
  const lines = [
    'MARKET-DATA DIAGNOSTICS (allocation vs entitlement vs reception - read-only, no mutation)',
    '-------------------------------------------------------------------------------------------',
    `Generated: ${report.generatedAt}`,
    '',
    `Allocated: ${report.summary.allocatedLines}  Receiving: ${report.summary.receivingLines}  `
    + `Fresh: ${report.summary.freshLines}  Stale: ${report.summary.staleLines}  Error: ${report.summary.errorLines}`,
    `Entitlement failures (354/10089): ${report.summary.entitlementFailures}  Contract failures (200): ${report.summary.contractFailures}`,
    '',
  ];
  if (report.symbols.length === 0) {
    lines.push('(no symbols allocated)');
    return lines.join('\n');
  }
  lines.push(
    'Symbol'.padEnd(8) + 'State'.padEnd(18) + 'LiveAgeMs'.padEnd(11) + 'DelayedBid'.padEnd(12)
    + 'DelayedAsk'.padEnd(12) + 'DelayedLast'.padEnd(13) + 'DelayedClose'.padEnd(14) + 'LastError',
  );
  for (const s of report.symbols) {
    const fmt = (v: { price: number } | null) => v ? v.price.toFixed(2) : '-';
    lines.push(
      s.symbol.padEnd(8)
      + s.marketDataLineState.padEnd(18)
      + String(s.liveQuote?.ageMs ?? '-').padEnd(11)
      + fmt(s.delayedQuote?.bid ?? null).padEnd(12)
      + fmt(s.delayedQuote?.ask ?? null).padEnd(12)
      + fmt(s.delayedQuote?.last ?? null).padEnd(13)
      + fmt(s.delayedQuote?.close ?? null).padEnd(14)
      + (s.latestError ? `code=${s.latestError.code}` : '-'),
    );
  }
  return lines.join('\n');
}
