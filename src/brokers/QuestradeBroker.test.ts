import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB, no per-module mocks for the DB layer - only
 * global `fetch` is mocked, since a real Questrade account isn't available). Verifies the
 * request/response mapping against Questrade's documented API shapes, and - the part most likely
 * to silently break a real deployment - that a rotated refresh token actually gets persisted.
 */
describe('QuestradeBroker', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let QuestradeBroker: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_questrade_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../server/db'));
    schema = await import('../server/db/schema');
    ({ QuestradeBroker } = await import('./QuestradeBroker'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  afterEach(() => vi.unstubAllGlobals());

  function mockTokenExchange(overrides: Partial<{ access_token: string; api_server: string; refresh_token: string; expires_in: number }> = {}) {
    return vi.fn(async (url: string) => {
      if (url.includes('login.questrade.com')) {
        return {
          ok: true,
          json: async () => ({
            access_token: overrides.access_token ?? 'access-abc',
            api_server: overrides.api_server ?? 'https://api01.iq.questrade.com/',
            expires_in: overrides.expires_in ?? 1800,
            refresh_token: overrides.refresh_token ?? 'rotated-refresh-xyz',
            token_type: 'Bearer',
          }),
        };
      }
      if (url.includes('/v1/accounts') && !url.includes('/balances') && !url.includes('/positions') && !url.includes('/orders')) {
        return { ok: true, json: async () => ({ accounts: [{ number: '12345678', isPrimary: true }] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
  }

  it('returns false immediately when no refresh token is configured', async () => {
    delete process.env.QUESTRADE_REFRESH_TOKEN;
    const broker = new QuestradeBroker();
    expect(await broker.authenticate({})).toBe(false);
  });

  it('exchanges the refresh token, auto-discovers the account number, and persists the rotated refresh token', async () => {
    vi.stubGlobal('fetch', mockTokenExchange());
    const broker = new QuestradeBroker();

    const ok = await broker.authenticate({ apiKey: 'original-refresh-token' });
    expect(ok).toBe(true);

    const [conn] = await db.select().from(schema.brokerConnections).where(eq(schema.brokerConnections.brokerName, 'Questrade (Canada)'));
    expect(conn).toBeDefined();
    expect(conn.apiKeyEncrypted).toBeTruthy();
    expect(conn.apiKeyEncrypted).not.toContain('rotated-refresh-xyz'); // must be encrypted, not stored in plaintext

    const { EncryptionService } = await import('../server/core/EncryptionService');
    expect(EncryptionService.decrypt(conn.apiKeyEncrypted)).toBe('rotated-refresh-xyz');
  });

  it('uses an explicitly provided account number instead of auto-discovering one', async () => {
    const fetchMock = mockTokenExchange();
    vi.stubGlobal('fetch', fetchMock);
    const broker = new QuestradeBroker();
    await broker.authenticate({ apiKey: 'refresh-token', secretKey: '99999999' });

    await broker.orders();
    const ordersCall = fetchMock.mock.calls.find((c: any[]) => c[0].includes('/orders'));
    expect(ordersCall[0]).toContain('/accounts/99999999/orders');
  });

  it('maps real balances/positions response shapes into Portfolio/Position', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('login.questrade.com')) {
        return { ok: true, json: async () => ({ access_token: 'a', api_server: 'https://api01.iq.questrade.com/', expires_in: 1800, refresh_token: 'r2' }) };
      }
      if (url.includes('/balances')) {
        return { ok: true, json: async () => ({ combinedBalances: [{ cash: 5000, buyingPower: 10000, totalEquity: 15000 }] }) };
      }
      if (url.includes('/positions')) {
        return {
          ok: true,
          json: async () => ({
            positions: [{ symbol: 'SHOP.TO', openQuantity: 10, averageEntryPrice: 100, currentPrice: 120, currentMarketValue: 1200, openPnl: 200, totalCost: 1000 }],
          }),
        };
      }
      if (url.includes('/v1/accounts') && !url.includes('/balances') && !url.includes('/positions')) {
        return { ok: true, json: async () => ({ accounts: [{ number: '11112222' }] }) };
      }
      return { ok: true, json: async () => ({}) };
    }));

    const broker = new QuestradeBroker();
    await broker.authenticate({ apiKey: 'refresh-token' });
    const portfolio = await broker.portfolio();

    expect(portfolio.cash).toBe(5000);
    expect(portfolio.buyingPower).toBe(10000);
    expect(portfolio.equity).toBe(15000);
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.positions[0].symbol).toBe('SHOP.TO');
    expect(portfolio.positions[0].unrealizedPnl).toBe(200);
  });

  it('maps real order response shapes, including state -> status translation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('login.questrade.com')) {
        return { ok: true, json: async () => ({ access_token: 'a', api_server: 'https://api01.iq.questrade.com/', expires_in: 1800, refresh_token: 'r2' }) };
      }
      if (url.includes('/orders')) {
        return {
          ok: true,
          json: async () => ({
            orders: [
              { id: 555, symbol: 'XIU.TO', side: 'Buy', orderType: 'Limit', state: 'Executed', totalQuantity: 100, filledQuantity: 100, limitPrice: 30, avgExecPrice: 29.95, creationTime: '2026-01-01T00:00:00Z', updateTime: '2026-01-01T00:01:00Z' },
            ],
          }),
        };
      }
      if (url.includes('/v1/accounts') && !url.includes('/orders')) {
        return { ok: true, json: async () => ({ accounts: [{ number: '33334444' }] }) };
      }
      return { ok: true, json: async () => ({}) };
    }));

    const broker = new QuestradeBroker();
    await broker.authenticate({ apiKey: 'refresh-token' });
    const orders = await broker.orders();

    expect(orders).toHaveLength(1);
    expect(orders[0].symbol).toBe('XIU.TO');
    expect(orders[0].side).toBe('BUY');
    expect(orders[0].type).toBe('LIMIT');
    expect(orders[0].status).toBe('FILLED');
    expect(orders[0].averageFillPrice).toBe(29.95);
  });

  it('placeOrder/modifyOrder still refuse - Questrade order execution is permanently partner-only, regardless of authentication', async () => {
    const broker = new QuestradeBroker();
    await expect(broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }))
      .rejects.toThrow(/partner/i);
    await expect(broker.modifyOrder('x', {})).rejects.toThrow(/partner/i);
    expect(await broker.cancelOrder('x')).toBe(false);
  });

  it('getCapabilities never claims order-placement capability', () => {
    const broker = new QuestradeBroker();
    expect(broker.getCapabilities().canPlaceOrders).toBe(false);
  });

  describe('getQuote / getHistoricalCandles (real market-data endpoints for MarketDataCrossChecker)', () => {
    function mockWithMarketData(overrides: { quote?: any; candles?: any[] } = {}) {
      return vi.fn(async (url: string) => {
        if (url.includes('login.questrade.com')) {
          return { ok: true, json: async () => ({ access_token: 'a', api_server: 'https://api01.iq.questrade.com/', expires_in: 1800, refresh_token: 'r3' }) };
        }
        if (url.includes('/v1/symbols?names=')) {
          return { ok: true, json: async () => ({ symbols: [{ symbol: 'AAPL', symbolId: 8049 }] }) };
        }
        if (url.includes('/v1/markets/quotes/')) {
          return { ok: true, json: async () => ({ quotes: [overrides.quote ?? { bidPrice: 189.5, askPrice: 189.55, lastTradePrice: 189.52, volume: 1000 }] }) };
        }
        if (url.includes('/v1/markets/candles/')) {
          return { ok: true, json: async () => ({ candles: overrides.candles ?? [] }) };
        }
        if (url.includes('/v1/accounts') && !url.includes('/balances') && !url.includes('/positions') && !url.includes('/orders')) {
          return { ok: true, json: async () => ({ accounts: [{ number: '12345678' }] }) };
        }
        return { ok: true, json: async () => ({}) };
      });
    }

    it('resolves a real symbolId then maps the real quote response shape', async () => {
      const fetchMock = mockWithMarketData();
      vi.stubGlobal('fetch', fetchMock);
      const broker = new QuestradeBroker();
      await broker.authenticate({ apiKey: 'refresh-token' });

      const quote = await broker.getQuote('AAPL');

      expect(fetchMock.mock.calls.some((c: any[]) => c[0].includes('/v1/symbols?names=AAPL'))).toBe(true);
      expect(fetchMock.mock.calls.some((c: any[]) => c[0].includes('/v1/markets/quotes/8049'))).toBe(true);
      expect(quote).toEqual({ symbol: 'AAPL', bid: 189.5, ask: 189.55, last: 189.52, volume: 1000, timestamp: expect.any(String) });
    });

    it('caches the resolved symbolId across repeated getQuote calls for the same symbol', async () => {
      const fetchMock = mockWithMarketData();
      vi.stubGlobal('fetch', fetchMock);
      const broker = new QuestradeBroker();
      await broker.authenticate({ apiKey: 'refresh-token' });

      await broker.getQuote('AAPL');
      const callsAfterFirst = fetchMock.mock.calls.filter((c: any[]) => c[0].includes('/v1/symbols?names=')).length;
      await broker.getQuote('AAPL');
      const callsAfterSecond = fetchMock.mock.calls.filter((c: any[]) => c[0].includes('/v1/symbols?names=')).length;

      expect(callsAfterFirst).toBe(1);
      expect(callsAfterSecond).toBe(1); // second call reused the cache, no new symbol lookup
    });

    it('falls back through bid/ask when lastTradePrice is missing (e.g. a halted/illiquid symbol)', async () => {
      vi.stubGlobal('fetch', mockWithMarketData({ quote: { bidPrice: 10, askPrice: 10.1, lastTradePrice: null, volume: 0 } }));
      const broker = new QuestradeBroker();
      await broker.authenticate({ apiKey: 'refresh-token' });
      const quote = await broker.getQuote('AAPL');
      expect(quote.last).toBe(10); // bidPrice fallback, not a fabricated value
    });

    it('maps real candle response shape and truncates to the requested limit, most-recent-last', async () => {
      const rawCandles = Array.from({ length: 10 }, (_, i) => ({
        start: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000 + i,
      }));
      vi.stubGlobal('fetch', mockWithMarketData({ candles: rawCandles }));
      const broker = new QuestradeBroker();
      await broker.authenticate({ apiKey: 'refresh-token' });

      const candles = await broker.getHistoricalCandles('AAPL', '1Day', 3);

      expect(candles).toHaveLength(3);
      expect(candles[2]).toEqual({ timestamp: '2026-08-10T00:00:00Z', open: 109, high: 110, low: 108, close: 109.5, volume: 1009 });
    });

    it('requests the Questrade interval enum matching the given Alpaca-style timeframe string', async () => {
      const fetchMock = mockWithMarketData();
      vi.stubGlobal('fetch', fetchMock);
      const broker = new QuestradeBroker();
      await broker.authenticate({ apiKey: 'refresh-token' });

      await broker.getHistoricalCandles('AAPL', '15Min', 5);

      const candlesCall = fetchMock.mock.calls.find((c: any[]) => c[0].includes('/v1/markets/candles/'));
      expect(candlesCall[0]).toContain('interval=FifteenMinutes');
    });

    it('rejects when no symbol match exists rather than fabricating a symbolId', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('login.questrade.com')) {
          return { ok: true, json: async () => ({ access_token: 'a', api_server: 'https://api01.iq.questrade.com/', expires_in: 1800, refresh_token: 'r4' }) };
        }
        if (url.includes('/v1/symbols?names=')) return { ok: true, json: async () => ({ symbols: [] }) };
        return { ok: true, json: async () => ({}) };
      }));
      const broker = new QuestradeBroker();
      await broker.authenticate({ apiKey: 'refresh-token' });
      await expect(broker.getQuote('NOTASYMBOL')).rejects.toThrow(/no symbol match/i);
    });
  });
});
