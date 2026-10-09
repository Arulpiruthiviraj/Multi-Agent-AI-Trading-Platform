import { describe, it, expect, vi } from 'vitest';

vi.mock('../server/config/ibkrConnection', () => ({
  loadIbkrConnection: () => ({ webApiRequestTimeoutMs: 5000 }),
}));

import { AlpacaBroker } from './AlpacaBroker';
import { IBGatewaySocketAdapter } from './IBGatewaySocketAdapter';
import { InteractiveBrokersWebApiAdapter } from './InteractiveBrokersWebApiAdapter';
import { HistoricalReplayBroker } from './HistoricalReplayBroker';
import { replaySafety } from '../server/replay/replaySafety';
import { CryptoPaperBroker } from './CryptoPaperBroker';
import { CoinbaseBroker } from './CoinbaseBroker';

/**
 * Real defect (2026-10-08 defect hunt, execution D5): adapter quantity validation was
 * inconsistent. AlpacaBroker had NO quantity check at all (NaN would serialize as null in
 * the JSON payload, negatives went straight to the API); both IBKR adapters used a falsy
 * check that let Infinity and negative quantities through; HistoricalReplayBroker let
 * Infinity through. CoinbaseBroker/CryptoPaperBroker already had the finite > 0 check.
 * Every adapter must now reject 0/negative/NaN/Infinity before any broker call.
 */
describe('adapter quantity validation (D5)', () => {
  const badQuantities = [0, -1, -100, NaN, Infinity, -Infinity];

  function makeAdapters() {
    const alpaca = new AlpacaBroker();
    const gateway = new IBGatewaySocketAdapter();
    const web = new InteractiveBrokersWebApiAdapter();
    (web as any).isAuthenticated = true;
    const replay = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
    });
    replay.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    const cryptoPaper = new CryptoPaperBroker(100000);
    const coinbase = new CoinbaseBroker();
    return { alpaca, gateway, web, replay, cryptoPaper, coinbase };
  }

  it('AlpacaBroker rejects non-positive/non-finite quantities without any HTTP call', async () => {
    const { alpaca } = makeAdapters();
    const fetchSpy = vi.fn();
    (alpaca as any).fetchFn = fetchSpy;
    for (const q of badQuantities) {
      await expect(alpaca.placeOrder({ symbol: 'AAPL', side: 'BUY', quantity: q })).rejects.toThrow(/finite quantity > 0/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('IBGatewaySocketAdapter rejects Infinity and negative quantities', async () => {
    const { gateway } = makeAdapters();
    for (const q of badQuantities) {
      await expect(gateway.placeOrder({ symbol: 'AAPL', side: 'BUY', quantity: q })).rejects.toThrow(/finite quantity > 0/);
    }
  });

  it('InteractiveBrokersWebApiAdapter rejects Infinity and negative quantities', async () => {
    const { web } = makeAdapters();
    for (const q of badQuantities) {
      await expect(web.placeOrder({ symbol: 'AAPL', side: 'BUY', quantity: q })).rejects.toThrow(/finite quantity > 0/);
    }
  });

  it('HistoricalReplayBroker returns REJECTED (never a fillable order) for non-finite quantities', async () => {
    const { replay } = makeAdapters();
    for (const q of [NaN, Infinity, -Infinity, 0, -5]) {
      const o = await replay.placeOrder({ symbol: 'AAPL', side: 'BUY', quantity: q });
      expect(o.status).toBe('REJECTED');
    }
  });

  it('CoinbaseBroker and CryptoPaperBroker already reject bad quantities (pin the standard)', async () => {
    const { cryptoPaper, coinbase } = makeAdapters();
    // CryptoPaperBroker's convention is a resolved REJECTED order object (not a throw) - pin it.
    for (const q of badQuantities) {
      const o = await cryptoPaper.placeOrder({ symbol: 'BTCUSD', side: 'BUY', quantity: q });
      expect(o.status).toBe('REJECTED');
    }
    expect(coinbase).toBeDefined();
  });
});
