type Client = (path: string, init?: RequestInit) => Promise<any>;

/** Uses the existing validated settings API, never writes SQLite or enables trading. */
export async function paperAllocationProfile(client: Client, budget: number, apply = false) {
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('Invalid PAPER allocation profile.');
  const settings = await client('/api/v1/config/settings');
  const status = await client('/api/v2/runtime/status');
  const state = status?.autobot;
  if (settings?.tradingMode !== 'PAPER' || state?.tradingMode !== 'PAPER'
    || settings?.autoBotEnabled !== false || state?.enabled !== false
    || state?.tradingState !== 'TRADING_PAUSED') {
    throw new Error('PAPER profile requires confirmed PAPER mode, disabled Autobot and TRADING_PAUSED. No settings changed.');
  }
  if (!Number.isFinite(settings.maxTradeSize) || settings.maxTradeSize <= 0) throw new Error('Current order ceiling unavailable.');
  const proposed = { budget, maxTradeSize: Math.min(budget, settings.maxTradeSize) };
  const before = { budget: settings.budget, maxTradeSize: settings.maxTradeSize };
  if (!apply) return { applied: false, before, proposed };
  const result = await client('/api/v1/config/settings', { method: 'POST', body: JSON.stringify(proposed) });
  if (result?.ok !== true) throw new Error('Settings API did not confirm the profile update.');
  const verified = await client('/api/v1/config/settings');
  if (verified.budget !== proposed.budget || verified.maxTradeSize !== proposed.maxTradeSize) {
    throw new Error('Profile write was acknowledged but persisted readback differs. Review settings before use.');
  }
  return { applied: true, before, verified: proposed };
}
