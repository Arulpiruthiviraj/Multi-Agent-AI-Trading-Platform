import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { desc, eq } from 'drizzle-orm';
import { parsePauseKindFromReason, withPauseKindMarker } from './TradingEngine';

describe('pause-kind marker', () => {
  it('round-trips ENTRIES_ONLY and defaults everything else to FULL (fail closed)', () => {
    expect(parsePauseKindFromReason(withPauseKindMarker('Operator pause', 'ENTRIES_ONLY'))).toBe('ENTRIES_ONLY');
    expect(parsePauseKindFromReason(withPauseKindMarker('Operator pause', 'FULL'))).toBe('FULL');
    expect(parsePauseKindFromReason('Reconciliation mismatch pause')).toBe('FULL');
    expect(parsePauseKindFromReason(null)).toBe('FULL');
    expect(parsePauseKindFromReason(undefined)).toBe('FULL');
  });
});

/**
 * 2026-10-13: an ENTRIES_ONLY pause must survive a process restart (clean-shutdown pause -> next boot), and automated
 * safety pauses (reconciliation mismatch etc.) must stay FULL. Real TradingEngine + isolated DB.
 */
describe('TradingEngine pause kind persistence across restart', () => {
  let tmp: string; let db: any; let sqliteDb: any; let schema: any; let TradingEngineMod: any;
  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_pausekind_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    TradingEngineMod = await import('./TradingEngine');
    await db.insert(schema.settings).values({ tradingMode: 'Paper', autoBotEnabled: true, budget: 20000, maxTradeSize: 1000 });
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });

  async function restartedKind() {
    // simulate a new process: wipe the in-memory trading state, then run the real boot-time load from settings + ledger
    const eng = TradingEngineMod.tradingEngine;
    eng.state.tradingState = 'TRADING_ENABLED';
    eng.state.pauseKind = 'FULL';
    await eng.initialize();
    return { state: eng.state.tradingState, kind: eng.state.pauseKind };
  }

  it('ENTRIES_ONLY pause persisted by a (shutdown/operator) transition is restored as ENTRIES_ONLY after restart', async () => {
    const eng = TradingEngineMod.tradingEngine;
    await eng.setTradingState('TRADING_PAUSED', { reason: 'Process shutdown drain', actor: 'gracefulShutdown', pauseKind: 'ENTRIES_ONLY' });
    const row = (await db.select().from(schema.killSwitchEvents).orderBy(desc(schema.killSwitchEvents.id)).limit(1))[0];
    expect(row.reason).toContain('[pauseKind=ENTRIES_ONLY]');
    expect(await restartedKind()).toEqual({ state: 'TRADING_PAUSED', kind: 'ENTRIES_ONLY' });
  });

  it('an automated safety pause (no pauseKind) is restored as FULL', async () => {
    const eng = TradingEngineMod.tradingEngine;
    await eng.setTradingState('TRADING_PAUSED', { reason: 'Reconciliation mismatch', actor: 'PortfolioReconciliation' });
    expect(await restartedKind()).toEqual({ state: 'TRADING_PAUSED', kind: 'FULL' });
  });

  it('EMERGENCY_STOP is never entries-only, and resume clears the kind', async () => {
    const eng = TradingEngineMod.tradingEngine;
    await eng.setTradingState('TRADING_PAUSED', { reason: 'op', actor: 'admin', pauseKind: 'ENTRIES_ONLY' });
    await eng.setTradingState('EMERGENCY_STOP', { reason: 'halt', actor: 'admin', pauseKind: 'ENTRIES_ONLY' });
    expect(eng.state.pauseKind).toBe('FULL');
    await eng.setTradingState('TRADING_ENABLED', { reason: 'resume', actor: 'admin' });
    expect(eng.state.pauseKind).toBe('FULL');
    void eq;
  });
});
