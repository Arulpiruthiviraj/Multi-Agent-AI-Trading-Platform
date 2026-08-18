import { describe, it, expect } from 'vitest';
import { InteractiveBrokersAdapter } from './InteractiveBrokersAdapter';
import { loadRepoConfigJson } from '../server/config/loadRepoConfigJson';

const catalog = loadRepoConfigJson<{ paperAccountIdPrefixes: string[]; liveAccountIdPrefixes: string[] }>('ibkrAccountClassification.json');

function adapterWithSession(accountId: string, mode: 'paper' | 'live' | 'unset') {
  const adapter = new InteractiveBrokersAdapter('https://localhost:5000/v1/api');
  (adapter as any).isAuthenticated = true;
  (adapter as any).accountId = accountId;
  if (mode === 'paper') adapter.paperTrading();
  if (mode === 'live') adapter.liveTrading();
  return adapter;
}

describe('InteractiveBrokersAdapter session isolation', () => {
  const order = { symbol: 'AAPL', side: 'BUY' as const, type: 'MARKET' as const, quantity: 1 };

  it('paperTrading + live Gateway account refuses placeOrder before HTTP', async () => {
    const adapter = adapterWithSession(`${catalog.liveAccountIdPrefixes[0]}999`, 'paper');
    await expect(adapter.placeOrder(order)).rejects.toThrow(/IBKR_LIVE_SESSION_IN_PAPER/);
  });

  it('liveTrading + paper Gateway account refuses placeOrder before HTTP', async () => {
    const adapter = adapterWithSession(`${catalog.paperAccountIdPrefixes[0]}999`, 'live');
    await expect(adapter.placeOrder(order)).rejects.toThrow(/IBKR_PAPER_SESSION_IN_LIVE/);
  });

  it('unset mode refuses placeOrder even for a classifiable paper account', async () => {
    const adapter = adapterWithSession(`${catalog.paperAccountIdPrefixes[0]}999`, 'unset');
    await expect(adapter.placeOrder(order)).rejects.toThrow(/IBKR_SESSION_MODE_UNKNOWN/);
  });
});
