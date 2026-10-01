/**
 * ARGUS Crypto Expansion Phase 4 (2026-09-21). Real BTC/ETH market-data ingestion into the
 * CANONICAL observed-quote cache MarketDataWorker.ts already owns (cacheObservedQuote/
 * getLatestPrice/getLatestPriceAgeMs) - deliberately not a second, competing freshness cache. Real
 * discovery this session: quoteKey() is `String(symbol).trim().toUpperCase()` with no equity-only
 * regex, so "BTC-USD" round-trips through that cache exactly like "AAPL" does - RiskEngine gate 13
 * (data_freshness) and tradeIdeaContract.ts's live-price lookup already read generically from it
 * and needed ZERO code changes once this module starts writing to it.
 *
 * REST polling (AlpacaCryptoMarketData.ts), not a WebSocket stream - no crypto streaming
 * connection exists in this codebase yet. This is an honest interim mechanism, not a permanent
 * architecture decision; a future phase may add real-time streaming through the same seam.
 *
 * Off by default (ARGUS_CRYPTO_MARKET_DATA_INGESTION_ENABLED) - start() re-checks the flag and
 * no-ops when disabled, same pattern as OpportunityDiscoveryWorker.start(). Never imports
 * ChiefTraderAgent/RiskEngine-as-a-decision-path/OrderManagement/BrokerManager/a broker adapter;
 * only writes prices into MarketDataWorker's existing cache, exactly as the real Alpaca equities
 * WebSocket path already does via emitMarketData().
 */
// @ts-nocheck

import { marketDataWorker } from './MarketDataWorker';
import { getLatestCryptoQuotes } from '../crypto/live/AlpacaCryptoMarketData';
import { listCryptoInstruments, isCryptoMarketDataIngestionEnabled, type CryptoInstrumentDefinition } from '../config/cryptoInstruments';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { structuredLogger } from '../observability/StructuredLogger';
import { createSingleFlightGuard, type SingleFlightIntervalMetrics } from '../core/singleFlightInterval';

function providerSymbolOf(instrument: CryptoInstrumentDefinition): string {
  return `${instrument.baseAsset}/${instrument.quoteAsset}`;
}

export class CryptoMarketDataIngestionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTickAtMs: number | null = null;
  private lastError: string | null = null;
  private generation = 0;
  private request: AbortController | null = null;
  private guard = createSingleFlightGuard();

  start(): void {
    if (!isCryptoMarketDataIngestionEnabled()) {
      console.log('[CryptoMarketDataIngestion] ARGUS_CRYPTO_MARKET_DATA_INGESTION_ENABLED is not true - idle.');
      return;
    }
    if (this.running) return;
    this.running = true;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, runtimeIntervals.cryptoMarketDataIngestionMs);
  }

  stop(): void {
    this.generation++;
    this.request?.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): { running: boolean; lastTickAtMs: number | null; lastError: string | null; polling: SingleFlightIntervalMetrics } {
    return { running: this.running, lastTickAtMs: this.lastTickAtMs, lastError: this.lastError, polling: this.guard.getMetrics() };
  }

  async tick(): Promise<void> {
    return this.guard.run(() => this.fetchTick());
  }

  private async fetchTick(): Promise<void> {
    const generation = this.generation;
    const request = new AbortController();
    this.request = request;
    const instruments = listCryptoInstruments().filter((i) => i.enabledForPaper);
    if (instruments.length === 0) return;
    const providerSymbols = instruments.map(providerSymbolOf);
    let quotes;
    try {
      quotes = await getLatestCryptoQuotes(providerSymbols, request.signal);
      if (generation !== this.generation || request.signal.aborted) return;
      this.lastError = null;
    } catch (e) {
      if (generation !== this.generation || request.signal.aborted) return;
      // Never fabricate a quote and never throw out of a timer callback - the same instrument
      // simply stays stale (gate 13/12 both already fail closed on that) until the next poll.
      this.lastError = e instanceof Error ? e.message : String(e);
      structuredLogger.warn('crypto_market_data_ingestion_failed', {
        category: 'OBSERVABILITY',
        component: 'CryptoMarketDataIngestion',
        error: this.lastError,
      });
      this.lastTickAtMs = Date.now();
      return;
    }
    for (const instrument of instruments) {
      const q = quotes.get(providerSymbolOf(instrument));
      if (!q || !Number.isFinite(q.midPrice) || q.midPrice <= 0) continue;
      const observedAtMs = Date.parse(q.timestamp);
      if (!Number.isFinite(observedAtMs) || observedAtMs > Date.now()) continue;
      marketDataWorker.cacheObservedQuote(
        instrument.canonicalSymbol,
        q.midPrice,
        observedAtMs,
      );
    }
    this.lastTickAtMs = Date.now();
  }
}

export const cryptoMarketDataIngestionWorker = new CryptoMarketDataIngestionWorker();
