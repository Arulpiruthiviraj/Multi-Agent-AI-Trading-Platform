import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * CRITICAL SAFETY SUITE for the Strategy Engine's optional integration (per the build directive's
 * Section 21 "Critical safety tests" list). These are the tests that must never be weakened to
 * make a feature "work" - if one of these ever needs to be loosened to ship something, that is a
 * sign the something should not ship.
 */

const SHADOW_RUNNER_PATH = path.join(__dirname, 'StrategyEngineShadowRunner.ts');
const STRATEGIES_ENGINE_DIR = path.join(__dirname, '..', 'strategiesEngine');

function readAllTsFiles(dir: string): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAllTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push({ file: full, content: fs.readFileSync(full, 'utf8') });
  }
  return out;
}

const DANGEROUS_SYMBOLS = [
  'OrderManagement', 'executeOrder', 'placeOrder', 'BrokerManager', 'activeBroker',
  'RiskEngine', 'RiskAgent', 'ChiefTraderAgent', 'cancelOrder',
];

describe('CRITICAL SAFETY: static isolation (Strategy Engine cannot reach the broker/risk path)', () => {
  it('StrategyEngineShadowRunner.ts contains zero REAL (non-comment) references to broker/order/risk symbols', () => {
    const content = fs.readFileSync(SHADOW_RUNNER_PATH, 'utf8');
    const realHits: string[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue; // doc-comment mention of the isolation contract itself
      for (const symbol of DANGEROUS_SYMBOLS) {
        if (line.includes(symbol)) realHits.push(line.trim());
      }
    }
    expect(realHits, `Real (non-comment) references found:\n${realHits.join('\n')}`).toEqual([]);
  });

  it('the entire src/server/strategiesEngine/ tree contains zero REAL references to broker/order/risk symbols (doc-comments describing the isolation contract are the only allowed mentions)', () => {
    const files = readAllTsFiles(STRATEGIES_ENGINE_DIR);
    const realHits: string[] = [];
    for (const { file, content } of files) {
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue; // doc-comment mention of the isolation contract itself
        for (const symbol of DANGEROUS_SYMBOLS) {
          if (line.includes(symbol)) realHits.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(realHits, `Real (non-comment) references found:\n${realHits.join('\n')}`).toEqual([]);
  });

  it('the backtest runner never imports OrderManagement/BrokerManager', () => {
    const content = fs.readFileSync(path.join(STRATEGIES_ENGINE_DIR, 'backtest', 'runBacktest.ts'), 'utf8');
    expect(content.includes('OrderManagement')).toBe(false);
    expect(content.includes('BrokerManager')).toBe(false);
  });
});

describe('CRITICAL SAFETY: dynamic behavior (real DB, real tick, real assertions)', () => {
  let tmpDbPath: string;
  let db: any;
  let schema: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_strategy_engine_safety_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db } = await import('../db'));
    schema = await import('../db/schema');
  });

  afterAll(() => {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('CRITICAL SAFETY #1: STRATEGY_ENGINE OFF (the real DB default) produces a pure no-op tick', async () => {
    const { StrategyEngineShadowRunner } = await import('./StrategyEngineShadowRunner');
    const runner = new StrategyEngineShadowRunner();
    // No settings row inserted at all - matches a fresh install, where the column default
    // (strategyEngineEnabled=false) is what a real row would carry once one exists.
    const result = await runner.tick();
    expect(result.ran).toBe(false);
    expect(result.signalsRecorded).toBe(0);
    const signalRows = await db.select().from(schema.strategyEngineSignals);
    expect(signalRows.length).toBe(0);
  });

  it('CRITICAL SAFETY #1b: explicit strategyEngineEnabled=false still no-ops even with a mode set', async () => {
    const { StrategyEngineShadowRunner } = await import('./StrategyEngineShadowRunner');
    await db.insert(schema.settings).values({ strategyEngineEnabled: false, strategyEngineMode: 'SHADOW', strategyEngineActiveIdsJson: JSON.stringify(['anything']) }).run();
    const runner = new StrategyEngineShadowRunner();
    const result = await runner.tick();
    expect(result.ran).toBe(false);
    await db.delete(schema.settings).run();
  });

  it('CRITICAL SAFETY: an unrecognized mode value (not SHADOW/ANALYSIS_ONLY) no-ops even when enabled=true', async () => {
    const { StrategyEngineShadowRunner } = await import('./StrategyEngineShadowRunner');
    await db.insert(schema.settings).values({ strategyEngineEnabled: true, strategyEngineMode: 'LIVE_ELIGIBLE', strategyEngineActiveIdsJson: JSON.stringify(['anything']) }).run();
    const runner = new StrategyEngineShadowRunner();
    const result = await runner.tick();
    expect(result.ran).toBe(false); // only 'SHADOW'/'ANALYSIS_ONLY' are real in this pass
    await db.delete(schema.settings).run();
  });

  it('CRITICAL SAFETY #2: SHADOW mode with real active strategies never calls a broker/OMS function, and only writes to strategy_engine_signals', async () => {
    // Real module-level spies on the actual OMS singleton - proves that even IF the shadow runner
    // somehow imported it (it doesn't, per the static test above), no such call happens at runtime.
    const oms = await import('../services/OrderManagement');
    const executeOrderSpy = vi.spyOn(oms.oms, 'executeOrder');

    const { defaultRegistry } = await import('../strategiesEngine/index');
    const anyStrategy = defaultRegistry.listAll()[0];
    expect(anyStrategy).toBeTruthy();

    await db.insert(schema.settings).values({
      strategyEngineEnabled: true,
      strategyEngineMode: 'SHADOW',
      strategyEngineActiveIdsJson: JSON.stringify([anyStrategy.id]),
      strategyEngineMaxActive: 25,
    }).run();

    // Seed real SPY bars locally so getBars() has real history without a live network call.
    let price = 400;
    const now = Date.now();
    for (let i = 0; i < 260; i++) {
      price += (i % 7 === 0 ? -1 : 0.6);
      const ts = now - (260 - i) * 24 * 60 * 60 * 1000;
      await db.insert(schema.ohlcvBars).values({
        id: `SPY:1Day:${ts}`, symbol: 'SPY', timeframe: '1Day', timestamp: ts,
        open: price, high: price + 1, low: price - 1, close: price, volume: 5_000_000, source: 'test-fixture',
      }).run();
    }

    const { StrategyEngineShadowRunner } = await import('./StrategyEngineShadowRunner');
    const runner = new StrategyEngineShadowRunner();
    const result = await runner.tick();

    expect(result.ran).toBe(true);
    expect(executeOrderSpy).not.toHaveBeenCalled(); // the real assertion this whole test exists for

    const signalRows = await db.select().from(schema.strategyEngineSignals);
    for (const row of signalRows) {
      expect(['SHADOW', 'ANALYSIS_ONLY']).toContain(row.evidenceClass);
    }

    executeOrderSpy.mockRestore();
    await db.delete(schema.settings).run();
    await db.delete(schema.strategyEngineSignals).run();
    await db.delete(schema.ohlcvBars).run();
  });

  it('CRITICAL SAFETY: an active id that is not a real registered strategy is skipped, never guessed at', async () => {
    await db.insert(schema.settings).values({
      strategyEngineEnabled: true, strategyEngineMode: 'SHADOW',
      strategyEngineActiveIdsJson: JSON.stringify(['STRAT-FAKE-DOES-NOT-EXIST-V1']),
    }).run();
    const { StrategyEngineShadowRunner } = await import('./StrategyEngineShadowRunner');
    const runner = new StrategyEngineShadowRunner();
    const result = await runner.tick();
    expect(result.signalsRecorded).toBe(0);
    await db.delete(schema.settings).run();
  });

  it('malformed strategyEngineActiveIdsJson fails closed (zero signals), never throws', async () => {
    await db.insert(schema.settings).values({
      strategyEngineEnabled: true, strategyEngineMode: 'SHADOW', strategyEngineActiveIdsJson: 'not valid json{{{',
    }).run();
    const { StrategyEngineShadowRunner } = await import('./StrategyEngineShadowRunner');
    const runner = new StrategyEngineShadowRunner();
    await expect(runner.tick()).resolves.toEqual({ ran: true, signalsRecorded: 0 });
    await db.delete(schema.settings).run();
  });
});
