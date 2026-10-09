/**
 * Regression tests for the 2026-10-08 defect hunt (news D2 / infra P2-R1/P2-R3):
 * escalation_decisions, jev_shadow_scores, news_predictions, staged_news_catalysts
 * (terminal rows) and ai_calls were append-only with no prune path. Each sweeper must
 * prune old rows, keep recent ones, and (for staged catalysts) never touch live rows.
 *
 * Isolation: ARGUS_DB_PATH points at a temp SQLite file; migrations run on import
 * (same pattern as newsRetention.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('news-adjacent retention sweeps (D2/P2-R1/P2-R3)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let sweepers: Record<string, (nowMs?: number) => Promise<number>>;

  const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const daysAgoMs = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_adjretention_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../db/index'));
    const m = await import('./operationalRetention');
    sweepers = {
      sweepEscalationDecisionsRetention: m.sweepEscalationDecisionsRetention,
      sweepJevShadowScoresRetention: m.sweepJevShadowScoresRetention,
      sweepNewsPredictionsRetention: m.sweepNewsPredictionsRetention,
      sweepStagedNewsCatalystsTerminalRetention: m.sweepStagedNewsCatalystsTerminalRetention,
      sweepAiCallsRetention: m.sweepAiCallsRetention,
    };
  });

  afterAll(() => {
    try { fs.unlinkSync(tmpDbPath); } catch { /* best effort */ }
    delete process.env.ARGUS_DB_PATH;
  });

  it('escalation_decisions: prunes rows older than 7d, keeps recent', async () => {
    const oldId = `esc-old-${Date.now()}`;
    const newId = `esc-new-${Date.now()}`;
    const ins = sqliteDb.prepare(
      `INSERT INTO escalation_decisions (id, timestamp, agent, task, local_source, local_signal_available, decisive_threshold, escalated, reason)
       VALUES (?, ?, 'NewsAgent', 'news_sentiment_analysis', 'finbert', 1, 0.5, 0, 'r')`
    );
    ins.run(oldId, daysAgoIso(8));
    ins.run(newId, daysAgoIso(1));
    const deleted = await sweepers.sweepEscalationDecisionsRetention();
    expect(deleted).toBe(1);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM escalation_decisions WHERE id=?').get(oldId).n).toBe(0);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM escalation_decisions WHERE id=?').get(newId).n).toBe(1);
  });

  it('jev_shadow_scores: prunes rows older than 30d, keeps recent', async () => {
    const oldId = `jev-old-${Date.now()}`;
    const newId = `jev-new-${Date.now()}`;
    const ins = sqliteDb.prepare(
      `INSERT INTO jev_shadow_scores (id, article_fingerprint, symbol, jev_model, scored_at)
       VALUES (?, 'fp', 'NVDA', 'jev-1', ?)`
    );
    ins.run(oldId, daysAgoIso(31));
    ins.run(newId, daysAgoIso(1));
    const deleted = await sweepers.sweepJevShadowScoresRetention();
    expect(deleted).toBe(1);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM jev_shadow_scores WHERE id=?').get(oldId).n).toBe(0);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM jev_shadow_scores WHERE id=?').get(newId).n).toBe(1);
  });

  it('news_predictions: prunes rows older than 90d, keeps recent', async () => {
    const oldId = `np-old-${Date.now()}`;
    const newId = `np-new-${Date.now()}`;
    const ins = sqliteDb.prepare(
      `INSERT INTO news_predictions (id, cluster_id, trace_id, symbol, created_at, direction, confidence, expected_horizon, news_agent_mode, model_source)
       VALUES (?, 'c1', 't1', 'NVDA', ?, 'UP', 0.7, '1d', 'observe', 'test')`
    );
    ins.run(oldId, daysAgoIso(91));
    ins.run(newId, daysAgoIso(1));
    const deleted = await sweepers.sweepNewsPredictionsRetention();
    expect(deleted).toBe(1);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM news_predictions WHERE id=?').get(oldId).n).toBe(0);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM news_predictions WHERE id=?').get(newId).n).toBe(1);
  });

  it('staged_news_catalysts: prunes only old TERMINAL rows, never live ones', async () => {
    const ins = sqliteDb.prepare(
      `INSERT INTO staged_news_catalysts (trace_id, symbol, headline, source, credibility, catalyst_strength, trading_bias, contribution, reasoning, recorded_at, status, updated_at_ms)
       VALUES (?, 'NVDA', 'h', 's', 0.8, 'HIGH', 'BULLISH', 0.5, 'r', ?, ?, ?)`
    );
    const nowIso = new Date().toISOString();
    const oldTerminal = `stg-old-term-${Date.now()}`;
    const newTerminal = `stg-new-term-${Date.now()}`;
    const oldLive = `stg-old-live-${Date.now()}`;
    ins.run(oldTerminal, nowIso, 'CONSUMED', daysAgoMs(8));
    ins.run(newTerminal, nowIso, 'EXPIRED', daysAgoMs(1));
    ins.run(oldLive, nowIso, 'STAGED', daysAgoMs(30)); // live queue: size-pruned elsewhere, not here
    const deleted = await sweepers.sweepStagedNewsCatalystsTerminalRetention();
    expect(deleted).toBe(1);
    const count = (id: string) => sqliteDb.prepare('SELECT COUNT(*) AS n FROM staged_news_catalysts WHERE trace_id=?').get(id).n;
    expect(count(oldTerminal)).toBe(0);
    expect(count(newTerminal)).toBe(1);
    expect(count(oldLive)).toBe(1);
  });

  it('ai_calls: prunes rows older than 30d, keeps recent', async () => {
    const oldId = `aic-old-${Date.now()}`;
    const newId = `aic-new-${Date.now()}`;
    const ins = sqliteDb.prepare(
      `INSERT INTO ai_calls (id, agent, provider, status, created_at) VALUES (?, 'NewsAgent', 'test', 'success', ?)`
    );
    ins.run(oldId, daysAgoIso(31));
    ins.run(newId, daysAgoIso(1));
    const deleted = await sweepers.sweepAiCallsRetention();
    expect(deleted).toBe(1);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE id=?').get(oldId).n).toBe(0);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE id=?').get(newId).n).toBe(1);
  });
});
