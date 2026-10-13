import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EVENTS } from '../core/eventNames';

/**
 * 2026-10-12 (n): behavioral coverage for CampaignOpeningSurge's optional Quant re-eval -
 * `void quantSignalAgent.evaluateSymbol(symbol)` fires for a passing candidate only when the
 * operator already enabled QUANT_ENGINE_ENABLED (never auto-enables). Driven with a stubbed
 * symbol input (synthetic bars with RVOL + ORB ABOVE) and asserting the observable effects:
 * the evaluateSymbol call (or its absence), the returned hits, and the emitted surge event.
 * No fabricated market data is presented as real - the bars are an explicit synthetic fixture
 * for the candidate-evaluation logic only.
 */
const evaluateSymbol = vi.hoisted(() => vi.fn());
const isRuntimeFlagEnabled = vi.hoisted(() => vi.fn((_key: string) => false));

vi.mock('./QuantSignalAgent', () => ({ quantSignalAgent: { evaluateSymbol } }));
vi.mock('../config/effectiveRuntimeConfig', () => ({ isRuntimeFlagEnabled }));
vi.mock('./NewsCatalystStore', () => ({ getNewsCatalysts: vi.fn(() => []) }));
vi.mock('../config/continuousIntelligence', () => ({
  continuousIntelligence: { campaignOpeningSurgeSymbols: ['STUB'] },
}));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ limit: async () => [{ campaignEnabled: true }] }) }) },
}));

// Synthetic 1Min bars: 15 bars on a prior UTC day at ~100, then 16 bars on the surge day
// rising to a 110 close (above the prior day's 101 high -> ORB ABOVE) with a volume spike
// on the final bar (RVOL 20x, well above the 1.5x minimum) so the candidate passes.
function bar(ts: number, price: number, volume: number) {
  return { timestamp: ts, open: price, high: price + 1, low: price - 1, close: price, volume };
}
const DAY1 = Date.parse('2026-10-09T13:00:00Z');
const DAY2 = Date.parse('2026-10-12T13:00:00Z');
const STUB_BARS = [
  ...Array.from({ length: 15 }, (_, i) => bar(DAY1 + i * 60_000, 100, 100)),
  ...Array.from({ length: 15 }, (_, i) => bar(DAY2 + i * 60_000, 100 + i, 100)),
  bar(DAY2 + 15 * 60_000, 110, 2000),
];

vi.mock('../engines/backtest/HistoricalDataGateway', () => ({
  historicalDataGateway: {
    ensureBars: vi.fn(async () => {}),
    getBars: vi.fn(() => STUB_BARS),
  },
}));

describe('CampaignOpeningSurge optional Quant re-eval (unfenced evaluateSymbol)', () => {
  let runCampaignOpeningSurge: (now?: Date) => Promise<{ ran: boolean; reason: string; hits: Array<{ symbol: string; reasons: string[] }> }>;
  let resetCampaignOpeningSurgeForTests: () => void;
  let eventBus: any;
  let surgeEvents: any[];
  let onSurge: (p: any) => void;

  // 09:30 ET on Mon 2026-10-12 - inside the 09:25-09:40 opening-surge window.
  const inWindow = () => new Date('2026-10-12T09:30:00-04:00');

  beforeEach(async () => {
    const mod = await import('./CampaignOpeningSurge');
    runCampaignOpeningSurge = mod.runCampaignOpeningSurge;
    resetCampaignOpeningSurgeForTests = mod.resetCampaignOpeningSurgeForTests;
    resetCampaignOpeningSurgeForTests();
    ({ eventBus } = await import('../core/EventBus'));
    evaluateSymbol.mockClear();
    isRuntimeFlagEnabled.mockReset();
    surgeEvents = [];
    onSurge = (p: any) => surgeEvents.push(p);
    eventBus.on(EVENTS.CAMPAIGN_OPENING_SURGE, onSurge);
  });

  afterEach(() => {
    eventBus.off(EVENTS.CAMPAIGN_OPENING_SURGE, onSurge);
  });

  it('calls quantSignalAgent.evaluateSymbol(symbol) for a passing candidate when QUANT_ENGINE_ENABLED is on', async () => {
    isRuntimeFlagEnabled.mockImplementation((key: string) => key === 'QUANT_ENGINE_ENABLED');

    const result = await runCampaignOpeningSurge(inWindow());

    expect(result.ran).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].symbol).toBe('STUB');
    expect(result.hits[0].reasons).toContain('ORB_ABOVE');
    // The behavioral effect of the unfenced call: the quant agent re-evaluates the symbol.
    expect(evaluateSymbol).toHaveBeenCalledTimes(1);
    expect(evaluateSymbol).toHaveBeenCalledWith('STUB', { origin: 'ON_DEMAND_CAMPAIGN_SURGE', requestedAtMs: expect.any(Number) });
    // The surge still emits its observability-only event (subscribe + confluence nudge path,
    // never a trade idea).
    expect(surgeEvents).toHaveLength(1);
    expect(surgeEvents[0].hits).toHaveLength(1);
    expect(surgeEvents[0].hits[0].symbol).toBe('STUB');
  });

  it('does NOT call evaluateSymbol when QUANT_ENGINE_ENABLED is off, but still records the hit', async () => {
    isRuntimeFlagEnabled.mockReturnValue(false);

    const result = await runCampaignOpeningSurge(inWindow());

    expect(result.ran).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].symbol).toBe('STUB');
    expect(evaluateSymbol).not.toHaveBeenCalled();
    expect(surgeEvents).toHaveLength(1);
  });

  it('a failing evaluateSymbol never breaks the surge run (the call is best-effort)', async () => {
    isRuntimeFlagEnabled.mockImplementation((key: string) => key === 'QUANT_ENGINE_ENABLED');
    evaluateSymbol.mockImplementation(() => { throw new Error('quant exploded'); });

    const result = await runCampaignOpeningSurge(inWindow());

    expect(result.ran).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(evaluateSymbol).toHaveBeenCalledWith('STUB', { origin: 'ON_DEMAND_CAMPAIGN_SURGE', requestedAtMs: expect.any(Number) });
  });
});
