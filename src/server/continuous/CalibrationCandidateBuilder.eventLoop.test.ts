import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-10-12 live forensic: the calibration validation cycle ran every 15 minutes and blocked the
 * whole engine for ~3.5-4 min (one core saturated, /health dead, PortfolioMonitor reviews missed).
 * Cause: fetchAgentPredictionRows() filtered only by agent in SQL and re-loaded the agent's entire
 * history (with reasoning text) once per (agent, bucket) row; fetchKronosRows() re-loaded the whole
 * kronos_predictions table plus every Kronos outcome per bucket. All synchronous.
 *
 * Two properties are pinned here:
 *  1. the candidates are numerically identical to the old per-bucket logic (no behavior change);
 *  2. the longest event-loop block while building candidates over a large history stays small.
 */
const AGENT_ROWS = 60_000;
const KRONOS_ROWS = 60_000;
const MAX_LOOP_BLOCK_MS = 400;
const AGENT = 'LagAgentA';
const BUCKETS: Array<[number, number]> = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.0]];

describe('CalibrationCandidateBuilder event-loop behavior', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('./CalibrationCandidateBuilder');
  let eff: typeof import('../research/effectiveSampleSize');
  let policy: typeof import('../research/predictionIndependencePolicy');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_calib_eventloop_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    mod = await import('./CalibrationCandidateBuilder');
    eff = await import('../research/effectiveSampleSize');
    policy = await import('../research/predictionIndependencePolicy');

    const now = new Date().toISOString();
    const insCal = sqliteDb.prepare('INSERT INTO agent_confidence_calibration (agent_name, bucket_low, bucket_high, wins, losses, calibrated_confidence, last_evaluated) VALUES (?,?,?,?,?,?,?)');
    for (const [lo, hi] of BUCKETS) insCal.run(AGENT, lo, hi, 1, 1, 0.5, now);
    for (const [lo, hi] of BUCKETS) insCal.run('KronosEngine', lo, hi, 1, 1, 0.5, now);

    const base = Date.parse('2026-09-01T14:00:00Z');
    const symbols = Array.from({ length: 120 }, (_, i) => `S${i}`);
    const insPred = sqliteDb.prepare('INSERT INTO agent_predictions (id, agent_name, symbol, prediction, confidence, reasoning, timestamp) VALUES (?,?,?,?,?,?,?)');
    const insKron = sqliteDb.prepare("INSERT INTO kronos_predictions (symbol, prediction, confidence, forecast_horizon, expected_move, volatility, support, resistance, model, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const insOut = sqliteDb.prepare('INSERT INTO prediction_outcomes (prediction_id, source_table, symbol, outcome, evaluated_at) VALUES (?,?,?,?,?)');
    const filler = 'deterministic reasoning text '.repeat(8);
    sqliteDb.transaction(() => {
      for (let i = 0; i < AGENT_ROWS; i++) {
        const sym = symbols[i % symbols.length];
        const conf = 0.5 + ((i * 7919) % 500) / 1000; // 0.500 .. 0.999
        const ts = new Date(base + i * 45_000).toISOString();
        const id = `lag-${i}`;
        insPred.run(id, AGENT, sym, i % 3 === 0 ? 'SELL' : 'BUY', conf, filler + i, ts);
        insOut.run(id, 'agent_predictions', sym, i % 5 === 0 ? 'N_A' : (i % 2 === 0 ? 'WIN' : 'LOSS'), now);
      }
      for (let i = 0; i < KRONOS_ROWS; i++) {
        const sym = symbols[(i * 3) % symbols.length];
        const ts = new Date(base + i * 50_000).toISOString();
        const info = insKron.run(sym, i % 2 === 0 ? 'BUY' : 'SELL', 55 + (i % 45), 5, '1%', 'LOW', 1, 2, 'm', ts);
        if (i % 7 === 0) insOut.run(String(info.lastInsertRowid), 'kronos_predictions', sym, i % 4 === 0 ? 'LOSS' : 'WIN', now);
      }
    })();
  }, 120_000);

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  /** The previous per-bucket logic, reproduced with raw SQL, as the reference for equivalence. */
  function referenceAgentBucket(bucket: [number, number]) {
    const rows = sqliteDb.prepare(
      `SELECT p.symbol symbol, p.prediction side, p.timestamp ts, p.trace_id traceId, p.reasoning reasoning,
              p.regime regime, p.confidence confidence, o.outcome outcome
         FROM agent_predictions p JOIN prediction_outcomes o ON o.prediction_id = p.id AND o.source_table = 'agent_predictions'
        WHERE p.agent_name = ?`).all(AGENT) as any[];
    const raw = rows
      .filter((r) => r.confidence >= bucket[0] && (r.confidence < bucket[1] || bucket[1] >= 1))
      .map((r) => ({ symbol: r.symbol, side: r.side, timestampMs: new Date(r.ts).getTime(), outcome: r.outcome, reasoning: r.reasoning, regime: r.regime }));
    const stats = eff.rawVsEffectiveDirectional(mod.toClusterableRows(AGENT, raw), policy.independenceClusterGapMs(AGENT));
    return { rawN: stats.rawN, rawWins: stats.rawWins, effectiveN: stats.effectiveN, effectiveWins: stats.effectiveWins };
  }

  it('produces the same statistics as the previous per-bucket logic (no behavior change)', async () => {
    const candidates = await mod.buildCalibrationCandidates();
    const mine = candidates.filter((c) => c.agentName === AGENT);
    expect(mine).toHaveLength(BUCKETS.length);
    for (const c of mine) {
      const expected = referenceAgentBucket([c.bucketLow, c.bucketHigh]);
      expect({ rawN: c.rawN, rawWins: c.rawWins, effectiveN: c.effectiveN, effectiveWins: c.effectiveWins }).toEqual(expected);
      expect(c.rawN).toBeGreaterThan(0);
    }
    // Kronos candidates exist for every active bucket and are built from real rows.
    expect(candidates.filter((c) => c.agentName === 'KronosEngine').length).toBeGreaterThan(0);
    // Output order follows the active calibration rows (agent first, then Kronos).
    expect(candidates.map((c) => c.agentName).slice(0, BUCKETS.length).every((a) => a === AGENT)).toBe(true);
  }, 120_000);

  it('never blocks the event loop for more than the bound while building candidates over a large history', async () => {
    let last = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const t = performance.now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
    }, 5);
    try {
      await mod.buildCalibrationCandidates();
    } finally {
      clearInterval(timer);
    }
    // IMPORTANT: if the work never yields, the sampler never fires during it and maxGap stays 0
    // (a vacuous pass). Account for the gap between the last tick and now.
    maxGap = Math.max(maxGap, performance.now() - last);
    expect(maxGap).toBeLessThan(MAX_LOOP_BLOCK_MS);
  }, 180_000);
});
