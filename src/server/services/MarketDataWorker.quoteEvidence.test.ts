import { expect, it } from 'vitest';
import { MarketDataWorker } from './MarketDataWorker';

it('reports only observed bid/ask evidence and invalidates it on a new subscription generation', () => {
  const worker = new MarketDataWorker();
  worker.setBrokerQuoteContext({ backend: 'ibkr_gateway' });
  worker.cacheObservedQuote('OKTA', 212);
  expect(worker.getObservedQuoteEvidence('OKTA')).toMatchObject({ observedPrice: 212, bid: null, ask: null });
  worker.ingestIbkrBidAsk('OKTA', 1, 211.9);
  worker.ingestIbkrBidAsk('OKTA', 2, 212.1);
  expect(worker.getObservedQuoteEvidence('OKTA')).toMatchObject({
    bid: 211.9, ask: 212.1, source: 'ibkr_gateway', bidObservedAtMs: expect.any(Number), askObservedAtMs: expect.any(Number),
  });
  worker.recordMarketDataSubscription('OKTA');
  expect(worker.getObservedQuoteEvidence('OKTA')).toMatchObject({ observedPrice: null, bid: null, ask: null, priceAgeMs: null });
});
