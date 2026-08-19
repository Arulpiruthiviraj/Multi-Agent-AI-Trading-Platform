import { describe, it, expect, vi } from 'vitest';
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

describe('InteractiveBrokersAdapter order-confirmation loop', () => {
  const order = { symbol: 'AAPL', side: 'BUY' as const, type: 'MARKET' as const, quantity: 1 };

  /**
   * Real bug found and fixed this pass: the confirmation loop used to reply {confirmed: true}
   * to every IBKR warning identically, including a duplicate-order warning - the same mechanism
   * IBKR uses for benign prompts (e.g. outside regular trading hours). A retried order
   * submission after a timeout would have had its duplicate-order warning silently
   * auto-accepted, risking an unintended double fill.
   */
  it('refuses to auto-confirm a duplicate-order warning instead of blindly accepting it', async () => {
    const adapter = adapterWithSession(`${catalog.paperAccountIdPrefixes[0]}999`, 'paper');
    vi.spyOn(adapter as any, 'resolveConid').mockResolvedValue(265598);
    const requestSpy = vi.spyOn(adapter as any, 'request').mockResolvedValueOnce([
      { id: 'confirm-1', message: ['This order is a duplicate of an existing order. Are you sure you want to submit this order?'] },
    ]);

    await expect(adapter.placeOrder(order)).rejects.toThrow(/duplicate order/i);
    // Must never have replied to the duplicate-order confirmation prompt.
    expect(requestSpy).not.toHaveBeenCalledWith(expect.stringContaining('/iserver/reply/'), expect.anything());
  });

  it('still auto-confirms a benign (non-duplicate) warning, preserving the existing documented flow', async () => {
    const adapter = adapterWithSession(`${catalog.paperAccountIdPrefixes[0]}999`, 'paper');
    vi.spyOn(adapter as any, 'resolveConid').mockResolvedValue(265598);
    const requestSpy = vi.spyOn(adapter as any, 'request')
      .mockResolvedValueOnce([{ id: 'confirm-2', message: ['This order will be submitted outside regular trading hours.'] }])
      .mockResolvedValueOnce([{ order_id: 'real-order-1', order_status: 'Submitted' }]);

    const result = await adapter.placeOrder(order);
    expect(result.id).toBe('real-order-1');
    expect(requestSpy).toHaveBeenCalledWith('/iserver/reply/confirm-2', expect.objectContaining({ body: { confirmed: true } }));
  });
});
