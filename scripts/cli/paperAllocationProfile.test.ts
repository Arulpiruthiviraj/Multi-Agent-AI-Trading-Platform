import { expect, it, vi } from 'vitest';
import { paperAllocationProfile } from './paperAllocationProfile';
import profile from '../../config/paperAllocationProfile.json';

const settings = { tradingMode: 'PAPER', autoBotEnabled: false, budget: 100000, maxTradeSize: 3000 };
const status = { autobot: { tradingMode: 'PAPER', enabled: false, tradingState: 'TRADING_PAUSED' } };

it('previews only unless explicitly applied', async () => {
  const client = vi.fn().mockResolvedValueOnce(settings).mockResolvedValueOnce(status);
  expect(await paperAllocationProfile(client, profile.budget)).toMatchObject({ applied: false, proposed: { budget: profile.budget } });
  expect(client).toHaveBeenCalledTimes(2);
});

it.each(['LIVE', 'TRADING_ENABLED', 'AUTOBOT_ENABLED'])('refuses an unsafe state: %s', async (kind) => {
  const unsafe = structuredClone(status);
  if (kind === 'LIVE') unsafe.autobot.tradingMode = 'LIVE';
  if (kind === 'TRADING_ENABLED') unsafe.autobot.tradingState = 'TRADING_ENABLED';
  if (kind === 'AUTOBOT_ENABLED') unsafe.autobot.enabled = true;
  const client = vi.fn().mockResolvedValueOnce(settings).mockResolvedValueOnce(unsafe);
  await expect(paperAllocationProfile(client, profile.budget, true)).rejects.toThrow('No settings changed');
  expect(client).toHaveBeenCalledTimes(2);
});

it('uses existing settings authority and verifies persisted values without increasing an order ceiling', async () => {
  const small = { ...settings, maxTradeSize: 100 };
  const client = vi.fn().mockResolvedValueOnce(small).mockResolvedValueOnce(status)
    .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ...small, budget: profile.budget });
  expect(await paperAllocationProfile(client, profile.budget, true)).toMatchObject({ applied: true });
  expect(client).toHaveBeenNthCalledWith(3, '/api/v1/config/settings', {
    method: 'POST', body: JSON.stringify({ budget: profile.budget, maxTradeSize: 100 }),
  });
});

it('does not claim success when the settings readback disagrees', async () => {
  const client = vi.fn().mockResolvedValueOnce(settings).mockResolvedValueOnce(status)
    .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(settings);
  await expect(paperAllocationProfile(client, profile.budget, true)).rejects.toThrow('persisted readback differs');
});
