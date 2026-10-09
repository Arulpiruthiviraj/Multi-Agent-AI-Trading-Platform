/**
 * Tests for the 8 retention sweepers added by the 2026-10-08 synthetic session
 * guard (SyntheticSessionGuards.test.ts). A 6-minute synthetic session wrote rows
 * to these tables, none of which had a prune path - the same defect class as
 * news_articles. These tests prove per-table cutoff semantics (old pruned, recent
 * kept) and idempotency. Same isolation pattern as newsRetention.test.ts:
 * ARGUS_DB_PATH points at a temp SQLite file; migrations run on import.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('session-guard retention sweeps', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let sweepers: Record<string, (nowMs?: number) => Promise<number>>;
  let intervals: any;

  const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const daysAgoMs = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000;
  const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_sessionguard_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../db/index'));
    const mod = await import('./operationalRetention');
    sweepers = {
      ohlcv_bars: mod.sweepOhlcvBarsRetention,
      agent_predictions: mod.sweepAgentPredictionsRetention,
      quant_assessments: mod.sweepQuantAssessmentsRetention,
      pit_decision_ledger: mod.sweepPitDecisionLedgerRetention,
      agent_reasoning_logs: mod.sweepAgentReasoningLogsRetention,
      transaction_traces: mod.sweepTransactionTracesRetention,
      session_lifecycle_snapshots: mod.sweepSessionLifecycleSnapshotsRetention,
      trade_lifecycle_transitions: mod.sweepTradeLifecycleTransitionsRetention,
    };
    ({ runtimeIntervals: intervals } = await import('../config/runtimeIntervals'));
  });

  afterAll(() => {
    try { fs.unlinkSync(tmpDbPath); } catch { /* best effort */ }
    delete process.env.ARGUS_DB_PATH;
  });

  const retentionKey: Record<string, string> = {
    ohlcv_bars: 'ohlcvBarsRetentionDays',
    agent_predictions: 'agentPredictionsRetentionDays',
    quant_assessments: 'quantAssessmentsRetentionDays',
    pit_decision_ledger: 'pitDecisionLedgerRetentionDays',
    agent_reasoning_logs: 'agentReasoningLogsRetentionDays',
    transaction_traces: 'transactionTracesRetentionDays',
    session_lifecycle_snapshots: 'sessionLifecycleSnapshotsRetentionDays',
    trade_lifecycle_transitions: 'tradeLifecycleTransitionsRetentionDays',
  };
  // Static list: describe-body collection runs before beforeAll populates sweepers.
  const TABLES = Object.keys(retentionKey);

  function insert(table: string, old: boolean) {
    const id = uid();
    const days = intervals[retentionKey[table]] as number;
    const iso = old ? daysAgoIso(days + 5) : daysAgoIso(0);
    const ms = old ? daysAgoMs(days + 5) : daysAgoMs(0);
    switch (table) {
      case 'ohlcv_bars':
        sqliteDb.prepare(`INSERT INTO ohlcv_bars (id, symbol, timeframe, timestamp, open, high, low, close, volume) VALUES (?, 'TST', '1Min', ?, 1, 2, 0.5, 1.5, 100)`).run(id, ms);
        break;
      case 'agent_predictions':
        sqliteDb.prepare(`INSERT INTO agent_predictions (id, agent_name, symbol, prediction, confidence, reasoning, timestamp) VALUES (?, 'a', 'TST', 'BUY', 0.8, 'r', ?)`).run(id, iso);
        break;
      case 'quant_assessments':
        sqliteDb.prepare(`INSERT INTO quant_assessments (id, symbol, timeframe, regime, market_context, created_at) VALUES (?, 'TST', '1h', '{}', '{}', ?)`).run(id, iso);
        break;
      case 'pit_decision_ledger':
        sqliteDb.prepare(`INSERT INTO pit_decision_ledger (id, as_of_ms, published_at_ms, symbol, kind, created_at) VALUES (?, ?, ?, 'TST', 'NEWS', ?)`).run(id, ms, ms, iso);
        break;
      case 'agent_reasoning_logs':
        sqliteDb.prepare(`INSERT INTO agent_reasoning_logs (trace_id, timestamp, agent_name, symbol, action, confidence, reasoning_summary) VALUES (?, ?, 'a', 'TST', 'act', 0.9, 'r')`).run(id, iso);
        break;
      case 'transaction_traces':
        sqliteDb.prepare(`INSERT INTO transaction_traces (trace_id, symbol, created_at, lifecycle_status) VALUES (?, 'TST', ?, 'DONE')`).run(id, iso);
        break;
      case 'session_lifecycle_snapshots':
        sqliteDb.prepare(`INSERT INTO session_lifecycle_snapshots (trading_date, market_session, app_state, evaluated_at, created_at) VALUES ('2026-10-08', 'CLOSED', '{}', ?, ?)`).run(iso, iso);
        break;
      case 'trade_lifecycle_transitions':
        sqliteDb.prepare(`INSERT INTO trade_lifecycle_transitions (id, candidate_id, symbol, state, created_at) VALUES (?, 'c', 'TST', 'OPEN', ?)`).run(id, iso);
        break;
    }
    return id;
  }

  function count(table: string): number {
    return (sqliteDb.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  }

  for (const table of TABLES) {
    it(`${table}: prunes rows older than retention, keeps recent rows, idempotent`, async () => {
      insert(table, true);   // old: must be pruned
      insert(table, false);  // recent: must survive
      const deleted = await sweepers[table]();
      expect(deleted).toBe(1);
      expect(count(table)).toBe(1);
      // Idempotent: second run deletes nothing.
      expect(await sweepers[table]()).toBe(0);
      expect(count(table)).toBe(1);
    });
  }
});
