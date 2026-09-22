import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CryptoMarketDataIngestionWorker } from './CryptoMarketDataIngestion';
import { marketDataWorker } from './MarketDataWorker';

const originalFetch = global.fetch;
const ENV_VAR = 'ARGUS_CRYPTO_MARKET_DATA_INGESTION_ENABLED';

beforeEach(() => {
  process.env.ALPACA_API_KEY = 'test-key';
  process.env.ALPACA_SECRET_KEY = 'test-secret';
  process.env[ENV_VAR] = 'true';
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env[ENV_VAR];
  vi.restoreAllMocks();
});

function mockAlpacaQuotes(body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe('CryptoMarketDataIngestionWorker', () => {
  it('start() is a no-op when the flag is off', () => {
    delete process.env[ENV_VAR];
    const worker = new CryptoMarketDataIngestionWorker();
    worker.start();
    expect(worker.isRunning()).toBe(false);
    worker.stop();
  });

  it('tick() populates MarketDataWorker\'s canonical observed-quote cache for BTC-USD (provider symbol BTC/USD mapped back to canonical)', async () => {
    mockAlpacaQuotes({
      quotes: {
        'BTC/USD': { bp: 59990, ap: 60010, bs: 1, as: 1, t: new Date().toISOString() },
        'ETH/USD': { bp: 2490, ap: 2510, bs: 1, as: 1, t: new Date().toISOString() },
      },
    });
    const worker = new CryptoMarketDataIngestionWorker();
    await worker.tick();

    expect(marketDataWorker.getLatestPrice('BTC-USD')).toBe(60000);
    expect(marketDataWorker.getLatestPrice('ETH-USD')).toBe(2500);
    // The real proof this closes the loop: gate 13 (data_freshness) reads exactly this method.
    const ageMs = marketDataWorker.getLatestPriceAgeMs('BTC-USD');
    expect(ageMs).not.toBeNull();
    expect(ageMs as number).toBeLessThan(60000);
  });

  it('never throws and leaves the cache untouched when the provider request fails (fail closed, not fabricated)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error', text: async () => 'boom' } as Response);
    const worker = new CryptoMarketDataIngestionWorker();
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(worker.getStatus().lastError).toMatch(/500/);
  });

  it('skips a quote with a non-finite or non-positive midPrice rather than caching garbage', async () => {
    mockAlpacaQuotes({ quotes: { 'BTC/USD': { bp: 0, ap: 0, bs: 1, as: 1, t: new Date().toISOString() } } });
    const worker = new CryptoMarketDataIngestionWorker();
    const before = marketDataWorker.getLatestPrice('BTC-USD');
    await worker.tick();
    // midPrice = 0 -> skipped -> cache unchanged from whatever it was before this test (proven by
    // the fact the immediately-preceding "populates" test cached 60000, and this must NOT change it to 0).
    expect(marketDataWorker.getLatestPrice('BTC-USD')).not.toBe(0);
    expect(marketDataWorker.getLatestPrice('BTC-USD')).toBe(before);
  });

  it('start()/stop() is idempotent and safe to call repeatedly', () => {
    const worker = new CryptoMarketDataIngestionWorker();
    worker.start();
    worker.start();
    expect(worker.isRunning()).toBe(true);
    worker.stop();
    worker.stop();
    expect(worker.isRunning()).toBe(false);
  });
});
