import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { CoinbaseBroker } from './CoinbaseBroker';
import { armLiveTrading, disarmLiveTrading, LIVE_TRADING_CONFIRMATION_PHRASE } from '../server/core/LiveTradingConfirmation';

// A real EC (P-256) key pair, generated fresh for this test run - not a fixture pretending to be
// a real Coinbase-issued key. Used to prove the JWT this broker builds is ACTUALLY verifiable with
// the matching public key, not just "doesn't throw" - the strongest check possible without a real
// Coinbase account to authenticate against.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const TEST_PRIVATE_KEY_PEM = privateKey.export({ type: 'sec1', format: 'pem' }).toString();

function decodeJwtPart(part: string): any {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
}

function verifyJwtSignature(jwt: string): boolean {
  const [headerB64, payloadB64, sigB64] = jwt.split('.');
  const signature = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return crypto.verify(
    'sha256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signature
  );
}

async function authedBroker(): Promise<CoinbaseBroker> {
  const broker = new CoinbaseBroker();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [] }) })));
  await broker.authenticate({ apiKey: 'organizations/org1/apiKeys/key1', secretKey: TEST_PRIVATE_KEY_PEM });
  vi.unstubAllGlobals();
  return broker;
}

describe('CoinbaseBroker', () => {
  const prevPaperTradingOnly = process.env.PAPER_TRADING_ONLY;

  afterEach(() => {
    vi.unstubAllGlobals();
    disarmLiveTrading();
    if (prevPaperTradingOnly === undefined) delete process.env.PAPER_TRADING_ONLY;
    else process.env.PAPER_TRADING_ONLY = prevPaperTradingOnly;
  });

  function armLivePlacement() {
    process.env.PAPER_TRADING_ONLY = 'false';
    armLiveTrading(LIVE_TRADING_CONFIRMATION_PHRASE);
  }

  describe('authenticate', () => {
    it('returns false when credentials are missing', async () => {
      const broker = new CoinbaseBroker();
      expect(await broker.authenticate({})).toBe(false);
    });

    it('accepts a PEM key with escaped \\n sequences (as stored in a single-line .env value)', async () => {
      const broker = new CoinbaseBroker();
      const escaped = TEST_PRIVATE_KEY_PEM.replace(/\n/g, '\\n');
      let capturedAuthHeader = '';
      vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
        capturedAuthHeader = opts.headers.Authorization;
        return { ok: true, json: async () => ({ accounts: [] }) };
      }));
      const ok = await broker.authenticate({ apiKey: 'organizations/org1/apiKeys/key1', secretKey: escaped });
      expect(ok).toBe(true);
      expect(capturedAuthHeader).toMatch(/^Bearer /);
    });

    it('returns false when the real Coinbase API rejects the credentials', async () => {
      const broker = new CoinbaseBroker();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => 'invalid signature' })));
      const ok = await broker.authenticate({ apiKey: 'organizations/org1/apiKeys/key1', secretKey: TEST_PRIVATE_KEY_PEM });
      expect(ok).toBe(false);
    });
  });

  describe('JWT construction (the part checkable without a live Coinbase account)', () => {
    it('produces a JWT whose signature is cryptographically verifiable against the matching public key', async () => {
      let capturedJwt = '';
      vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
        capturedJwt = opts.headers.Authorization.replace('Bearer ', '');
        return { ok: true, json: async () => ({ accounts: [] }) };
      }));
      const broker = new CoinbaseBroker();
      await broker.authenticate({ apiKey: 'organizations/org1/apiKeys/key1', secretKey: TEST_PRIVATE_KEY_PEM });

      expect(verifyJwtSignature(capturedJwt)).toBe(true);
    });

    it('sets the header/payload to Coinbase\'s documented CDP shape (alg, kid, sub, iss, uri)', async () => {
      let capturedJwt = '';
      vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
        capturedJwt = opts.headers.Authorization.replace('Bearer ', '');
        return { ok: true, json: async () => ({ accounts: [] }) };
      }));
      const broker = new CoinbaseBroker();
      await broker.authenticate({ apiKey: 'organizations/org1/apiKeys/key1', secretKey: TEST_PRIVATE_KEY_PEM });

      const [headerB64, payloadB64] = capturedJwt.split('.');
      const header = decodeJwtPart(headerB64);
      const payload = decodeJwtPart(payloadB64);

      expect(header.alg).toBe('ES256');
      expect(header.kid).toBe('organizations/org1/apiKeys/key1');
      expect(typeof header.nonce).toBe('string');
      expect(payload.sub).toBe('organizations/org1/apiKeys/key1');
      expect(payload.iss).toBe('cdp');
      expect(payload.uri).toBe('GET api.coinbase.com/api/v3/brokerage/accounts');
      expect(payload.exp - payload.nbf).toBe(120);
    });

    it('builds a fresh, distinct JWT (fresh nonce) for every request', async () => {
      const jwts: string[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
        jwts.push(opts.headers.Authorization);
        return { ok: true, json: async () => ({ accounts: [] }) };
      }));
      const broker = new CoinbaseBroker();
      await broker.authenticate({ apiKey: 'organizations/org1/apiKeys/key1', secretKey: TEST_PRIVATE_KEY_PEM });
      await broker.account();
      expect(jwts[0]).not.toBe(jwts[1]);
    });
  });

  describe('placeOrder', () => {
    it('refuses to place a real order while in paper mode (the default) - Coinbase has no sandbox to fall back to', async () => {
      const broker = await authedBroker();
      await expect(broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', type: 'MARKET', quantity: 0.01 }))
        .rejects.toThrow(/paper/i);
    });

    it('refuses live placement without LIVE_ARM even after liveTrading()', async () => {
      const broker = await authedBroker();
      broker.liveTrading();
      process.env.PAPER_TRADING_ONLY = 'false';
      await expect(broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', type: 'MARKET', quantity: 0.01 }))
        .rejects.toThrow(/LIVE_ARM_REQUIRED/);
    });

    it('places a real market order with the documented request shape once in live mode', async () => {
      const broker = await authedBroker();
      broker.liveTrading();
      armLivePlacement();

      let capturedBody: any;
      vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ success: true, success_response: { order_id: 'real-order-123' } }) };
      }));

      const order = await broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', type: 'MARKET', quantity: 0.01 });

      expect(order.id).toBe('real-order-123');
      expect(capturedBody.product_id).toBe('BTC-USD');
      expect(capturedBody.side).toBe('BUY');
      expect(capturedBody.order_configuration.market_market_ioc.base_size).toBe('0.01');
      expect(typeof capturedBody.client_order_id).toBe('string');
    });

    it('throws with the real broker-reported reason when Coinbase rejects the order', async () => {
      const broker = await authedBroker();
      broker.liveTrading();
      armLivePlacement();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ success: false, error_response: { message: 'Insufficient funds' } }),
      })));

      await expect(broker.placeOrder({ symbol: 'BTC-USD', side: 'BUY', type: 'MARKET', quantity: 100 }))
        .rejects.toThrow(/Insufficient funds/);
    });

    it('places a real limit order with the documented request shape', async () => {
      const broker = await authedBroker();
      broker.liveTrading();
      armLivePlacement();
      let capturedBody: any;
      vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ success: true, success_response: { order_id: 'limit-order-1' } }) };
      }));

      await broker.placeOrder({ symbol: 'ETH-USD', side: 'SELL', type: 'LIMIT', quantity: 1, price: 3000 });

      expect(capturedBody.order_configuration.limit_limit_gtc.base_size).toBe('1');
      expect(capturedBody.order_configuration.limit_limit_gtc.limit_price).toBe('3000');
    });
  });

  describe('cancelOrder', () => {
    it('reports success/failure from the real batch_cancel response shape', async () => {
      const broker = await authedBroker();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ results: [{ order_id: 'abc', success: true }] }),
      })));
      expect(await broker.cancelOrder('abc')).toBe(true);
    });

    it('reports false when the real response says the cancel failed', async () => {
      const broker = await authedBroker();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ results: [{ order_id: 'abc', success: false }] }),
      })));
      expect(await broker.cancelOrder('abc')).toBe(false);
    });
  });

  describe('positions/portfolio mapping from real Coinbase response shapes', () => {
    it('maps non-zero, non-fiat account balances to positions with real pricing', async () => {
      const broker = await authedBroker();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('/accounts')) {
          return {
            ok: true,
            json: async () => ({
              accounts: [
                { currency: 'USD', available_balance: { value: '500.00' } },
                { currency: 'BTC', available_balance: { value: '0.5' } },
                { currency: 'ETH', available_balance: { value: '0' } }, // zero balance - must be excluded
              ],
            }),
          };
        }
        if (url.includes('/products/BTC-USD')) {
          return { ok: true, json: async () => ({ price: '60000' }) };
        }
        return { ok: true, json: async () => ({}) };
      }));

      const positions = await broker.positions();
      expect(positions).toHaveLength(1);
      expect(positions[0].symbol).toBe('BTC-USD');
      expect(positions[0].quantity).toBe(0.5);
      expect(positions[0].currentPrice).toBe(60000);
      expect(positions[0].marketValue).toBe(30000);
    });

    it('reports the fiat balance as cash/buyingPower in portfolio()', async () => {
      const broker = await authedBroker();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('/accounts')) {
          return { ok: true, json: async () => ({ accounts: [{ currency: 'USD', available_balance: { value: '1234.56' } }] }) };
        }
        return { ok: true, json: async () => ({}) };
      }));

      const portfolio = await broker.portfolio();
      expect(portfolio.cash).toBe(1234.56);
      expect(portfolio.buyingPower).toBe(1234.56);
    });
  });
});
