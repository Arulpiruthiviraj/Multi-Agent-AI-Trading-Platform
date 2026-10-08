import { describe, it, expect, vi, afterAll } from 'vitest';

vi.mock('../core/EventBus', () => ({ eventBus: { on: vi.fn(), emit: vi.fn(), publish: vi.fn() } }));
vi.mock('../ai/AIRouter', () => ({
  AIRouter: { getInstance: () => ({ routeTask: vi.fn().mockResolvedValue({ content: '{"regime":"BULL_MARKET","confidence":0.9,"reasoning":"test"}' }) }) },
}));

import { MarketRegimeAgent, marketRegimeAgent } from './MarketRegimeAgent';

// The module singleton starts its 5-minute timer at import - stop it immediately so this test
// file does not leak a live handle into the worker.
marketRegimeAgent.stop();

afterAll(() => {
  marketRegimeAgent.stop();
});

/**
 * DEF-3 regression: MarketRegimeAgent's interval was set in the constructor with the handle
 * discarded (no stop() existed), the module singleton started ticking at import (leaking into
 * tests), and async detectRegime() had no overlap guard - when GEMINI_API_KEY is set each
 * cycle issues a real AI call, so overlapping cycles issued duplicate AI calls per interval.
 */
describe('MarketRegimeAgent timer lifecycle and single-flight detectRegime (DEF-3)', () => {
  it('stop() clears the constructor timer and is idempotent', () => {
    const agent = new MarketRegimeAgent() as any;
    expect(agent.intervalId).not.toBeNull();
    agent.stop();
    expect(agent.intervalId).toBeNull();
    expect(() => agent.stop()).not.toThrow();
  });

  it('overlapping detectRegime() calls do not run concurrently - the second is coalesced', async () => {
    delete process.env.GEMINI_API_KEY;
    const agent = new MarketRegimeAgent() as any;
    agent.stop(); // kill the real 5-minute timer; we drive detectRegime() manually
    // Let the constructor's initial detectRegime() settle so the guard is free.
    await new Promise((r) => setTimeout(r, 25));

    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    agent.detectRegimeImpl = async () => {
      calls++;
      await gate;
    };

    const p1 = agent.detectRegime();
    const p2 = agent.detectRegime();
    // Give p1 a chance to enter the guarded cycle before releasing it.
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(agent.regimeGuard.getMetrics().totalSkippedInFlight).toBeGreaterThanOrEqual(1);
  });

  it('detectRegime() still completes normally when not contended', async () => {
    delete process.env.GEMINI_API_KEY;
    const agent = new MarketRegimeAgent() as any;
    agent.stop();
    await new Promise((r) => setTimeout(r, 25));
    await agent.detectRegime();
    expect(agent.getCurrentRegime()).toBe('SIMULATED_BULL_MARKET');
  });
});
