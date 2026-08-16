import { describe, it, expect } from 'vitest';
import { collectStartupHealth } from './StartupHealthRegistry';

describe('StartupHealthRegistry', () => {
  it('never marks Quant READY unless QUANT_ENGINE_ENABLED is true', async () => {
    const prev = process.env.QUANT_ENGINE_ENABLED;
    process.env.QUANT_ENGINE_ENABLED = 'false';
    const rows = await collectStartupHealth(200);
    const quant = rows.find((r) => r.service === 'QuantSignalAgent');
    expect(quant?.status).toBe('DISABLED');
    expect(quant?.impact).toMatch(/never flips the flag/);
    if (prev === undefined) delete process.env.QUANT_ENGINE_ENABLED;
    else process.env.QUANT_ENGINE_ENABLED = prev;
  });

  it('marks OpenAlice DISABLED when OPENALICE_ENABLED is false', async () => {
    const rows = await collectStartupHealth(200);
    const oa = rows.find((r) => r.service === 'OpenAlice');
    expect(oa?.status).toBe('DISABLED');
  });
});
