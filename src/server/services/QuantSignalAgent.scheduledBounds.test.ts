import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-10-13: the legacy serial scheduled cycle must not turn into stale work. Real QuantSignalAgent.runCycle()
 * against a stubbed evaluator (control-plane test: it asserts WHICH symbols are evaluated/deferred/skipped and
 * that every non-evaluated symbol gets an explicit terminal state - never a silent drop).
 */
vi.mock('../ai/AIRouter', () => ({
  AIRouter: { getInstance: () => ({ routeTask: async () => { throw new Error('no AI'); }, routeConsensus: async () => null, hasAnyRoutableProvider: async () => false }) },
}));

describe('QuantSignalAgent scheduled cycle bounds', () => {
  let tmpDbPath: string;
  let sqliteDb: any; let QuantSignalAgent: any; let tradingSafety: any; let marketDataWorker: any; let structuredLogger: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quant_bounds_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    ({ tradingSafety } = await import('../config/tradingSafety'));
    ({ marketDataWorker } = await import('./MarketDataWorker'));
    ({ structuredLogger } = await import('../observability/StructuredLogger'));
    ({ QuantSignalAgent } = await import('./QuantSignalAgent'));
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmpDbPath + s); } catch { /* best effort */ } }
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  const run = async (agent: any, active: string[], held: string[], perEvalMs: number) => {
    vi.spyOn(marketDataWorker, 'getActiveSymbols').mockReturnValue(active);
    vi.spyOn(agent, 'getHeldSymbols').mockResolvedValue(new Set(held));
    const order: string[] = [];
    vi.spyOn(agent, 'evaluateSymbol').mockImplementation((async (symbol: string) => {
      order.push(symbol);
      vi.setSystemTime(Date.now() + perEvalMs);
      agent.lastEvaluationFinishedAtMs.set(symbol, Date.now());
      return { ok: true };
    }) as any);
    const logSpy = vi.spyOn(structuredLogger, 'info');
    await agent.runCycle();
    const events = (name: string) => logSpy.mock.calls.filter((c: any[]) => c[0] === name).map((c: any[]) => c[1] as any);
    return { order, events };
  };

  it('held positions are evaluated first, always', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T14:00:00Z') });
    const agent = new QuantSignalAgent();
    const { order } = await run(agent, ['SPY', 'QQQ', 'ZZZ', 'HELD1', 'AAA'], ['HELD1'], 1_000);
    expect(order[0]).toBe('HELD1');
  });

  it('defers (CAPACITY_DEFERRED) rather than evaluates obsolete work, and the next cycle resumes at the deferred symbol', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T14:00:00Z') });
    const bound = tradingSafety.quantScheduledMaxQueueAgeMs;
    const perEval = Math.floor(bound / 3) + 1; // after 3 evaluations the cycle is past its bound
    const symbols = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
    const agent = new QuantSignalAgent();
    const first = await run(agent, symbols, [], perEval);
    expect(first.order.length).toBeLessThan(symbols.length);
    const deferred = first.events('quant_symbols_capacity_deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ terminalState: 'CAPACITY_DEFERRED', deferredCount: symbols.length - first.order.length });
    const completed = first.events('quant_cycle_completed')[0];
    expect(completed.reason).toBe('CAPACITY_DEFERRED');
    expect(completed.notAttemptedSymbols).toEqual(symbols.slice(first.order.length));
    // every symbol is either evaluated or explicitly deferred - none vanish
    expect([...first.order, ...completed.notAttemptedSymbols].sort()).toEqual([...symbols].sort());

    // advance past the recent-evaluation skip window so only the resume logic is under test
    vi.setSystemTime(Date.now() + tradingSafety.quantScheduledSkipIfEvaluatedWithinMs + 1);
    vi.restoreAllMocks();
    const second = await run(agent, symbols, [], 1_000);
    expect(second.order[0]).toBe(completed.notAttemptedSymbols[0]);
  });

  it('skips a non-held symbol evaluated moments ago (SUPERSEDED_BY_RECENT_EVALUATION) but never skips a held one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T14:00:00Z') });
    const agent = new QuantSignalAgent();
    agent.lastEvaluationFinishedAtMs.set('RECENT', Date.now() - 10_000);
    agent.lastEvaluationFinishedAtMs.set('HELDRECENT', Date.now() - 10_000);
    const { order, events } = await run(agent, ['RECENT', 'HELDRECENT', 'FRESHNEEDED'], ['HELDRECENT'], 1_000);
    expect(order).toContain('HELDRECENT');
    expect(order).toContain('FRESHNEEDED');
    expect(order).not.toContain('RECENT');
    expect(events('quant_symbol_superseded_by_recent_evaluation').map((e: any) => e.symbol)).toEqual(['RECENT']);
    expect(events('quant_cycle_completed')[0].skippedRecentSymbols).toEqual(['RECENT']);
  });
});
