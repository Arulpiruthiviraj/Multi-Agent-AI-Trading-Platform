import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('strategyScorecard', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./strategyScorecard');
  let eligibility: typeof import('../quant/strategies/StrategyEmissionEligibility');
  let seq = 0;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_strategy_scorecard_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./strategyScorecard');
    eligibility = await import('../quant/strategies/StrategyEmissionEligibility');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function nextId(): string {
    seq += 1;
    return `sc-${seq}`;
  }

  async function seedOrganicRoundTrip(strategyId: string, symbol: string, entry: number, exit: number, qty: number, atIso: string) {
    const buyId = nextId();
    const sellId = nextId();
    await db.insert(schema.trades).values({ id: buyId, symbol, side: 'BUY', quantity: qty, price: entry, status: 'FILLED', timestamp: atIso, filledAt: atIso, quantStrategyId: strategyId });
    const exitIso = new Date(new Date(atIso).getTime() + 60_000).toISOString();
    await db.insert(schema.trades).values({ id: sellId, symbol, side: 'SELL', quantity: qty, price: exit, status: 'FILLED', timestamp: exitIso, filledAt: exitIso, profitLoss: (exit - entry) * qty });
  }

  it('a strategy with no evidence anywhere classifies as NO_EVIDENCE', async () => {
    const rows = await mod.buildStrategyScorecard([]);
    const row = rows.find((r) => r.strategyId === 'NEVER_SEEN_ANYWHERE');
    // Not present at all in fairness data either (no quant_assessments seeded for it) - this
    // confirms the scorecard never invents a row for a strategy with zero evidence in any source.
    expect(row).toBeUndefined();
  });

  it('a quarantined (RETIRED) strategy always classifies as NEGATIVE_EVIDENCE regardless of any organic profit - matches the real PULLBACK_CONTINUATION policy', async () => {
    await eligibility.quarantineStrategyForEmission('SC_QUARANTINED', 'test', {}, 30);
    for (let i = 0; i < 25; i++) {
      await seedOrganicRoundTrip('SC_QUARANTINED', 'AAPL', 100, 105, 10, `2026-01-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`);
    }
    const rows = await mod.buildStrategyScorecard([]);
    const row = rows.find((r) => r.strategyId === 'SC_QUARANTINED')!;
    expect(row.classification).toBe('NEGATIVE_EVIDENCE');
    expect(row.lifecycleStatus).toBe('RETIRED');
  });

  it('a strategy with a small number of organic winning trades (below 20) is PROMISING_BUT_INSUFFICIENT, never overclaimed', async () => {
    for (let i = 0; i < 8; i++) {
      await seedOrganicRoundTrip('SC_PROMISING', 'MSFT', 100, 103, 10, `2026-02-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`);
    }
    const rows = await mod.buildStrategyScorecard([]);
    const row = rows.find((r) => r.strategyId === 'SC_PROMISING')!;
    expect(row.classification).toBe('PROMISING_BUT_INSUFFICIENT');
  });

  it('a strategy with >=20 organic trades, Wilson lower bound above chance, and positive net P&L is PROFITABLE_PAPER_STRATEGY - the strongest possible claim, requiring real organic evidence', async () => {
    for (let i = 0; i < 25; i++) {
      await seedOrganicRoundTrip('SC_PROVEN', 'NVDA', 200, 210, 10, `2026-03-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`);
    }
    const rows = await mod.buildStrategyScorecard([]);
    const row = rows.find((r) => r.strategyId === 'SC_PROVEN')!;
    expect(row.classification).toBe('PROFITABLE_PAPER_STRATEGY');
  });

  it('a strategy with no organic evidence but a CONSISTENT_ABOVE_CHANCE replay verdict is WALK_FORWARD_SURVIVOR, never conflated with organic PAPER_VALIDATED/PROFITABLE tiers, and is never silently dropped just because it has no quant_assessments history', async () => {
    const rows = await mod.buildStrategyScorecard([
      { strategyId: 'SC_REPLAY_GOOD', totalClosedTrades: 40, totalNetPnl: 900, foldsWithEvidence: 3, foldsAboveChance: 3, foldsBelowChance: 0, status: 'CONSISTENT_ABOVE_CHANCE', reason: 'test' },
    ]);
    const row = rows.find((r) => r.strategyId === 'SC_REPLAY_GOOD')!;
    expect(row).toBeDefined();
    expect(row.classification).toBe('WALK_FORWARD_SURVIVOR');
    expect(row.classification).not.toBe('PROFITABLE_PAPER_STRATEGY');
    expect(row.classification).not.toBe('PAPER_VALIDATED');
  });

  it('CORE strategies always appear in the scorecard even with zero evidence anywhere (buildStrategyFairnessReport\'s own guarantee)', async () => {
    const rows = await mod.buildStrategyScorecard([]);
    const coreIds = rows.filter((r) => r.isCore).map((r) => r.strategyId);
    expect(coreIds.sort()).toEqual(['MEAN_REVERSION', 'MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'RANGE_REVERSION', 'TREND_FOLLOWING'].sort());
  });

  it('formatStrategyScorecard renders a readable table without crashing', async () => {
    const rows = await mod.buildStrategyScorecard([]);
    const text = mod.formatStrategyScorecard(rows);
    expect(text).toContain('21-STRATEGY SCORECARD');
    expect(text).toContain('MOMENTUM_BREAKOUT');
  });
});
