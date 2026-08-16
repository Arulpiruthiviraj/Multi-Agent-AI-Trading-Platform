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
});
