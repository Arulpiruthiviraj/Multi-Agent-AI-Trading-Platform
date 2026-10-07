import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eventBus } from '../core/EventBus';

describe('submitPipelineSells', () => {
  let tmpDbPath: string;
  let sqliteDb: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_flatten_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    const { tradingEngine } = await import('../engines/TradingEngine');
    await tradingEngine.initialize();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('refuses a symbol with no live price instead of calling the broker', async () => {
    const { submitPipelineSells } = await import('./PipelineFlatten');
    const result = await submitPipelineSells(['NOSUCHTICK']);
    expect(result.submitted).toHaveLength(0);
    expect(result.refused[0].reason).toMatch(/No live price/i);
  });

  it('emits CHIEF_APPROVED_IDEA SELL when a live price exists', async () => {
    const { marketDataWorker } = await import('./MarketDataWorker');
    (marketDataWorker as any).latestPrices.set('FLATTEN1', 10);
    const ideas: any[] = [];
    const onIdea = (idea: any) => ideas.push(idea);
    eventBus.on('CHIEF_APPROVED_IDEA', onIdea);
    try {
      const { submitPipelineSells } = await import('./PipelineFlatten');
      const result = await submitPipelineSells(['flatten1']);
      expect(result.submitted).toHaveLength(1);
      expect(result.submitted[0].symbol).toBe('FLATTEN1');
      expect(ideas.some((i) => i.symbol === 'FLATTEN1' && i.side === 'SELL')).toBe(true);
    } finally {
      eventBus.off('CHIEF_APPROVED_IDEA', onIdea);
    }
  });

  // 2026-10-07 (OKTA PAPER reconciliation follow-up): submitPipelineOrder's closePositionIntent
  // flag — proves it actually reaches the emitted CHIEF_APPROVED_IDEA payload (RiskEngine.ts reads
  // it from there, via RiskAgent.ts's forwarder) rather than being silently dropped anywhere in
  // this plumbing. Nested in this same describe block so it shares the real DB/tradingEngine
  // setup above instead of racing its teardown.
  it('includes closePositionIntent:true on the emitted CHIEF_APPROVED_IDEA when requested', async () => {
    const { marketDataWorker } = await import('./MarketDataWorker');
    (marketDataWorker as any).latestPrices.set('COVERTEST', 100);
    const ideas: any[] = [];
    const onIdea = (idea: any) => ideas.push(idea);
    eventBus.on('CHIEF_APPROVED_IDEA', onIdea);
    try {
      const { submitPipelineOrder } = await import('./PipelineFlatten');
      const result = await submitPipelineOrder('COVERTEST', 'BUY', 'test cover', true);
      expect('reason' in result).toBe(false);
      const emitted = ideas.find((i) => i.symbol === 'COVERTEST');
      expect(emitted?.side).toBe('BUY');
      expect(emitted?.closePositionIntent).toBe(true);
    } finally {
      eventBus.off('CHIEF_APPROVED_IDEA', onIdea);
    }
  });

  it('omits closePositionIntent (undefined) for an ordinary order', async () => {
    const { marketDataWorker } = await import('./MarketDataWorker');
    (marketDataWorker as any).latestPrices.set('ORDINARYTEST', 100);
    const ideas: any[] = [];
    const onIdea = (idea: any) => ideas.push(idea);
    eventBus.on('CHIEF_APPROVED_IDEA', onIdea);
    try {
      const { submitPipelineOrder } = await import('./PipelineFlatten');
      await submitPipelineOrder('ORDINARYTEST', 'BUY', 'ordinary rebalance idea');
      const emitted = ideas.find((i) => i.symbol === 'ORDINARYTEST');
      expect(emitted?.closePositionIntent).toBeUndefined();
    } finally {
      eventBus.off('CHIEF_APPROVED_IDEA', onIdea);
    }
  });
});
