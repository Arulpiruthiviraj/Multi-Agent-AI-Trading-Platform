import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLatestCryptoQuotes, getCryptoBars, getCryptoAccountStatus } from './AlpacaCryptoMarketData';

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.ALPACA_API_KEY = 'test-key';
  process.env.ALPACA_SECRET_KEY = 'test-secret';
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetchOnce(status: number, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe('getLatestCryptoQuotes', () => {
  it('throws rather than fabricating a quote when credentials are missing', async () => {
    delete process.env.ALPACA_API_KEY;
    await expect(getLatestCryptoQuotes(['BTC/USD'])).rejects.toThrow(/ALPACA_API_KEY/);
  });

  it('returns an empty map for an empty symbol list without making a network call', async () => {
    const spy = vi.fn();
    global.fetch = spy;
    const result = await getLatestCryptoQuotes([]);
    expect(result.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('parses a real-shaped Alpaca quote response into midPrice correctly', async () => {
    mockFetchOnce(200, {
      quotes: {
        'BTC/USD': { ap: 85933.1, as: 0.001, bp: 85905.576, bs: 0.001, t: '2026-09-21T17:29:37Z' },
      },
    });
    const result = await getLatestCryptoQuotes(['BTC/USD']);
    const quote = result.get('BTC/USD')!;
    expect(quote.bidPrice).toBe(85905.576);
    expect(quote.askPrice).toBe(85933.1);
    expect(quote.midPrice).toBeCloseTo((85905.576 + 85933.1) / 2, 6);
  });

  it('throws with the real HTTP status on a non-200 response rather than returning a fabricated quote', async () => {
    mockFetchOnce(401, { message: 'unauthorized' });
    await expect(getLatestCryptoQuotes(['BTC/USD'])).rejects.toThrow(/401/);
  });
});

describe('getCryptoBars', () => {
  it('maps real-shaped Alpaca bar fields correctly', async () => {
    mockFetchOnce(200, {
      bars: { 'BTC/USD': [{ t: '2026-09-01T00:00:00Z', o: 100, h: 110, l: 90, c: 105, v: 1.5, n: 800, vw: 102 }] },
      next_page_token: null,
    });
    const bars = await getCryptoBars('BTC/USD', '1Day', 0, Date.now());
    expect(bars).toHaveLength(1);
    expect(bars[0].open).toBe(100);
    expect(bars[0].close).toBe(105);
    expect(bars[0].timestampMs).toBe(new Date('2026-09-01T00:00:00Z').getTime());
  });

  it('follows pagination via next_page_token until exhausted', async () => {
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return {
          ok: true, status: 200,
          json: async () => ({ bars: { 'BTC/USD': [{ t: '2026-09-01T00:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }] }, next_page_token: 'page2' }),
        } as Response;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ bars: { 'BTC/USD': [{ t: '2026-09-02T00:00:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 }] }, next_page_token: null }),
      } as Response;
    });
    const bars = await getCryptoBars('BTC/USD', '1Day', 0, Date.now());
    expect(bars).toHaveLength(2);
    expect(call).toBe(2);
  });

  it('returns bars sorted chronologically regardless of response order', async () => {
    mockFetchOnce(200, {
      bars: {
        'BTC/USD': [
          { t: '2026-09-02T00:00:00Z', o: 2, h: 2, l: 2, c: 2, v: 2 },
          { t: '2026-09-01T00:00:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 },
        ],
      },
      next_page_token: null,
    });
    const bars = await getCryptoBars('BTC/USD', '1Day', 0, Date.now());
    expect(bars[0].timestampMs).toBeLessThan(bars[1].timestampMs);
  });

  it('throws rather than returning fabricated bars on a failed request', async () => {
    mockFetchOnce(500, { message: 'server error' });
    await expect(getCryptoBars('BTC/USD', '1Day', 0, Date.now())).rejects.toThrow(/500/);
  });
});

describe('getCryptoAccountStatus', () => {
  it('reports real account crypto status fields', async () => {
    mockFetchOnce(200, { crypto_status: 'ACTIVE', trading_blocked: false });
    const status = await getCryptoAccountStatus();
    expect(status.cryptoStatus).toBe('ACTIVE');
    expect(status.tradingBlocked).toBe(false);
  });
});
