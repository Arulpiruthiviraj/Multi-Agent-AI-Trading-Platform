import { describe, it, expect, vi, afterEach } from 'vitest';
import { AlpacaBroker } from './AlpacaBroker';

describe('AlpacaBroker.authenticate live URL (Phase 20)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not reset liveTrading() back to paper when isLive is omitted', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'acct' }) };
    }));
    const broker = new AlpacaBroker();
    broker.liveTrading();
    await broker.authenticate({ apiKey: 'k', secretKey: 's' });
    expect(urls.some((u) => u.startsWith('https://api.alpaca.markets'))).toBe(true);
    expect(urls.some((u) => u.includes('paper-api'))).toBe(false);
  });

  it('uses the live host when isLive: true', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'acct' }) };
    }));
    const broker = new AlpacaBroker();
    await broker.authenticate({ apiKey: 'k', secretKey: 's', isLive: true });
    expect(urls[0]).toMatch(/^https:\/\/api\.alpaca\.markets/);
  });

  it('uses paper host when isLive is omitted and liveTrading was never called', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'acct' }) };
    }));
    const broker = new AlpacaBroker();
    await broker.authenticate({ apiKey: 'k', secretKey: 's' });
    expect(urls[0]).toMatch(/^https:\/\/paper-api\.alpaca\.markets/);
  });

  it('throws on liveTrading() and LIVE authenticate when PAPER_TRADING_ONLY=true', async () => {
    const prev = process.env.PAPER_TRADING_ONLY;
    process.env.PAPER_TRADING_ONLY = 'true';
    try {
      const broker = new AlpacaBroker();
      expect(() => broker.liveTrading()).toThrow(/Cannot enable LIVE mode when PAPER_TRADING_ONLY is enforced/);
      await expect(broker.authenticate({ apiKey: 'k', secretKey: 's', isLive: true }))
        .rejects.toThrow(/Cannot enable LIVE mode when PAPER_TRADING_ONLY is enforced/);
    } finally {
      if (prev === undefined) delete process.env.PAPER_TRADING_ONLY;
      else process.env.PAPER_TRADING_ONLY = prev;
    }
  });
});
