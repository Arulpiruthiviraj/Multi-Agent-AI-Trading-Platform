import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { InternalPaperBroker } from './InternalPaperBroker';
import { AlpacaBroker } from './AlpacaBroker';
import { QuestradeBroker } from './QuestradeBroker';
import { CoinbaseBroker } from './CoinbaseBroker';
import { InteractiveBrokersAdapter } from './InteractiveBrokersAdapter';
import { brokerSupports, BrokerPlugin } from './BrokerAdapter';

const EXPECTED_CAPABILITY_KEYS = [
  'canPlaceOrders', 'canCancelOrders', 'paperTrading', 'liveTrading',
  'usEquities', 'canadianEquities', 'crypto', 'options', 'shortSelling',
  'streamingMarketData', 'requiresManualReauth',
] as const;

// Every broker the app knows about, real or stub. This contract test exists so a broker can never
// silently claim a capability its code doesn't back up (canPlaceOrders: true with an unimplemented
// placeOrder()), and so NON_FUNCTIONAL_BROKER_IDS in BrokerManager.ts stays in sync with reality.
const brokers: { plugin: BrokerPlugin; expectFunctional: boolean }[] = [
  { plugin: new InternalPaperBroker(), expectFunctional: true },
  { plugin: new AlpacaBroker(), expectFunctional: true },
  { plugin: new InteractiveBrokersAdapter(), expectFunctional: true },
  { plugin: new QuestradeBroker(), expectFunctional: false },
  { plugin: new CoinbaseBroker(), expectFunctional: false },
];

describe.each(brokers)('$plugin.name broker contract', ({ plugin, expectFunctional }) => {
  beforeAll(() => {
    // AlpacaBroker.placeOrder() calls the real Alpaca REST API via global fetch. Stub it so
    // this contract test never makes a real external network call - it only needs to observe
    // that a functional adapter fails with a real error, not the "Not implemented" stub message.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized (stubbed for test)',
    })));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('exposes a complete, boolean-typed BrokerCapabilities object', () => {
    const caps = plugin.getCapabilities();
    for (const key of EXPECTED_CAPABILITY_KEYS) {
      expect(caps).toHaveProperty(key);
      expect(typeof caps[key]).toBe('boolean');
    }
  });

  it(`declares canPlaceOrders as ${expectFunctional}`, () => {
    expect(plugin.getCapabilities().canPlaceOrders).toBe(expectFunctional);
  });

  it(`${expectFunctional ? 'does not' : 'does'} throw "Not implemented" from placeOrder() when canPlaceOrders is ${expectFunctional}`, async () => {
    if (expectFunctional) {
      // Functional adapters may still reject for real reasons (no network, not authenticated) -
      // the contract here is only that they never fail with the specific "Not implemented" stub
      // message a non-functional adapter uses.
      await plugin.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }).catch((e: Error) => {
        expect(e.message).not.toMatch(/Not implemented/);
      });
    } else {
      await expect(
        plugin.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 })
      ).rejects.toThrow(/Not implemented/);
    }
  });
});

describe('brokerSupports', () => {
  it('reflects the capability object rather than any hardcoded assumption', () => {
    const paperBroker = new InternalPaperBroker();
    expect(brokerSupports(paperBroker, 'canPlaceOrders')).toBe(true);
    expect(brokerSupports(paperBroker, 'liveTrading')).toBe(false);

    const questrade = new QuestradeBroker();
    expect(brokerSupports(questrade, 'canPlaceOrders')).toBe(false);
  });
});
