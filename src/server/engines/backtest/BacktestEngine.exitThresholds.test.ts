import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * E2A regression test (BACKTEST_QUANT_HARDENING_ANALYSIS.md): proves BacktestEngine.run()'s exit
 * logic actually reads settings.takeProfitPct/trailingStopPct rather than the previously-hardcoded
 * -5%/+15% literals. Uses a custom, non-default -8% stop threshold and a price decline that stops
 * short of -8% but would have tripped the old hardcoded -5% - if the settings read were not wired
 * up, this test's SELL would fire one bar earlier than it does. Kept in its own file (rather than
 * a second describe block in BacktestEngine.test.ts) because each test FILE gets its own isolated
 * module registry in this codebase's Vitest setup - a second `import('../../db')` inside the same
 * file resolves to the already-closed singleton from the first describe block's afterAll.
 */
describe('BacktestEngine.run - settings-driven exit thresholds (E2A)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let backtestEngine: any;
  const originalKey = process.env.ALPACA_API_KEY;
  const originalSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_backtestengine_exitpct_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ backtestEngine } = await import('./BacktestEngine'));

    // Custom, non-default thresholds - if either consumer fell back to a hardcoded literal
    // instead of reading these, the assertions below would fail.
    await db.insert(schema.settings).values({
      maxTradeSize: 5000, riskLevel: 'Balanced', maxOpenPositions: 10,
      takeProfitPct: 25, trailingStopPct: 8,
    });
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    if (originalKey === undefined) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.ALPACA_SECRET_KEY; else process.env.ALPACA_SECRET_KEY = originalSecret;
  });

  afterEach(() => vi.unstubAllGlobals());

  function buildBars(symbol: string, closes: number[], startTs: number, dayMs: number) {
    return closes.map((close, i) => ({
      id: `${symbol}:1Day:${startTs + i * dayMs}`,
      symbol, timeframe: '1Day', timestamp: startTs + i * dayMs,
      open: close, high: close * 1.01, low: close * 0.99, close, volume: 500_000,
      source: 'alpaca',
    }));
  }

  async function seedBars(rows: any[]) {
    for (const row of rows) await db.insert(schema.ohlcvBars).values(row);
  }

  function stubCleanFetch(seededRows: any[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('adjustment=raw')) return { ok: true, json: async () => ({ bars: [] }) };
      if (url.includes('adjustment=split')) {
        return { ok: true, json: async () => ({ bars: seededRows.map(r => ({ t: new Date(r.timestamp).toISOString(), c: r.close })) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
  }

  it('does not stop out a position at the old hardcoded -5% when settings.trailingStopPct=8', async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTs = new Date('2024-01-01').getTime();
    // 55 flat bars (establishes a mean-reversion BUY entry), then a decline that bottoms at
    // exactly -6% from entry (worse than the old hardcoded -5%, but inside the new -8% setting),
    // then recovers. If the -5% literal were still in effect, this would have exited earlier
    // with a realized loss capped near -5%; with the -8% setting wired in, the position should
    // never stop out on the way down.
    const closes = [
      ...Array.from({ length: 55 }, () => 100),
      95, 90, 85, 80, 75, 70, // triggers mean-reversion BUY around rsi<30/bbLower
      66, 63, 66, 70, 75, // bottoms ~-6% from an entry near 70, then recovers
    ];
    const rows = buildBars('E2ACO', closes, startTs, dayMs);
    await seedBars(rows);
    stubCleanFetch(rows);

    const result = await backtestEngine.run({
      symbols: ['E2ACO'],
      startDate: '2024-01-01',
      endDate: new Date(startTs + (closes.length + 1) * dayMs).toISOString().split('T')[0],
      initialCash: 100000,
    });

    expect(result.status).toBe('COMPLETED');
    const stopLossExits = result.tradeLog.filter((t: any) => t.side === 'SELL' && /Stop-loss/.test(t.reasoning));
    for (const exit of stopLossExits) {
      expect(exit.reasoning).toContain('-8.0%'); // reflects the configured setting, not a hardcoded -5%
    }
  });
});
