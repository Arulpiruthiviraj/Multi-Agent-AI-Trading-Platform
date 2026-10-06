/**
 * Outcome audits tests (workstream I, 2026-10-06, local-only).
 *
 * Covers the required cases:
 *  1. Filter-premise correctness is judged AT DECISION TIME: a SPREAD filter with
 *     genuinely wide spread at decision time is premise-correct (1) even when the
 *     stock later rallies +20% - the rally is recorded as outcome context, never
 *     as a verdict flip.
 *  2. Outcome windows never include the decision bar (same-bar hindsight test).
 *  3. Risk-rejected audit records gate + timestamp + reference price.
 *  4. premarket_known_by distinguishes 04:00 plans from 09:15 refresh sources.
 *  5. Session metrics persist per trading date.
 *
 * Pure-function tests need no market data; DB-backed tests use a temp SQLite DB
 * with all migrations applied plus a test-only mover_coverage fixture mirroring
 * workstream H's 0093 spec (removed/ignored once 0093 lands).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TRADING_DATE = '2026-10-06';

const TEST_THRESHOLDS = {
  maxSpreadBps: 100,
  minDollarVolume: 50000,
  minPrice: 1,
  maxPrice: 500,
  minAvgDailyVolumeShares: 100000,
  rankCap: null as number | null,
};

function minBar(hhmm: string, close: number, open?: number) {
  const ts = Date.parse(`${TRADING_DATE}T${hhmm}:00.000Z`);
  return { timestamp: ts, open: open ?? close, high: Math.max(open ?? close, close), low: Math.min(open ?? close, close), close, volume: 1000 };
}

describe('outcomeAudits', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('./outcomeAudits');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_outcomeaudits_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    const dbMod = await import('../db');
    sqliteDb = dbMod.sqliteDb;
    const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
    migrate(dbMod.db, { migrationsFolder: 'drizzle' });
    // Test-only fixture mirroring workstream H's 0093 mover_coverage spec.
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS mover_coverage (
        trading_date TEXT NOT NULL,
        symbol TEXT NOT NULL,
        eod_move_pct REAL,
        primary_fate TEXT,
        secondary_reasons TEXT,
        never_seen_cause TEXT,
        reference_price REAL,
        outcome_windows TEXT,
        filter_reason TEXT,
        filter_premise_correct INTEGER,
        premarket_known_by TEXT,
        UNIQUE(trading_date, symbol)
      );`);
    mod = await import('./outcomeAudits');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  // ------------------------------------------------------------------
  // 1. Premise correctness judged at decision time (never from outcome)
  // ------------------------------------------------------------------
  describe('judgeFilterPremise', () => {
    it('SPREAD with genuinely wide spread at decision time is premise-correct (1) even if the stock later rallies +20%', () => {
      // The judgment takes (reason, contemporaneous evidence, thresholds) ONLY -
      // there is no outcome parameter, so the later +20% rally recorded in
      // outcome_windows cannot flip this verdict by construction.
      const j = mod.judgeFilterPremise('SPREAD', { reason: 'SPREAD', spreadBps: 250, price: 10 }, TEST_THRESHOLDS);
      expect(j.premiseCorrect).toBe(1);
      expect(j.basis).toContain('250');
    });

    it('SPREAD within the ceiling is premise-incorrect (0)', () => {
      const j = mod.judgeFilterPremise('SPREAD', { reason: 'SPREAD', spreadBps: 40, price: 10 }, TEST_THRESHOLDS);
      expect(j.premiseCorrect).toBe(0);
    });

    it('SPREAD with no spread evidence is unjudgeable (null), never guessed', () => {
      const j = mod.judgeFilterPremise('SPREAD', { reason: 'SPREAD', price: 10 }, TEST_THRESHOLDS);
      expect(j.premiseCorrect).toBeNull();
    });

    it('ADV_DATA_UNAVAILABLE with null advShares correctly failed closed (1); with a real value the premise fails (0)', () => {
      expect(mod.judgeFilterPremise('ADV_DATA_UNAVAILABLE', { advShares: null }, TEST_THRESHOLDS).premiseCorrect).toBe(1);
      expect(mod.judgeFilterPremise('ADV_DATA_UNAVAILABLE', { advShares: 500000 }, TEST_THRESHOLDS).premiseCorrect).toBe(0);
    });

    it('unknown reason is unjudgeable (null)', () => {
      expect(mod.judgeFilterPremise('SOMETHING_NEW', { price: 5 }, TEST_THRESHOLDS).premiseCorrect).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // 2. Causal outcome windows - never the decision bar
  // ------------------------------------------------------------------
  describe('computeOutcomeWindows', () => {
    it('excludes the bar containing the decision timestamp (same-bar hindsight)', async () => {
      // Decision at 09:31:30Z sits INSIDE the 09:31 bar. That bar runs 100 -> 110
      // (+10% same-bar). Every window must anchor at the 09:31 CLOSE (110) and
      // count only strictly-later bars: the +10% same-bar move must not appear.
      const bars = [
        minBar('09:30', 100),
        minBar('09:31', 110, 100),
        minBar('09:32', 110),
        minBar('09:33', 110.5),
        minBar('09:34', 111),
        minBar('09:35', 111.5),
        minBar('09:36', 112),
        minBar('09:37', 112.5),
        minBar('10:31', 115),
        minBar('15:59', 120),
      ];
      const w = await mod.computeOutcomeWindows('AAA', `${TRADING_DATE}T09:31:30.000Z`, TRADING_DATE, async () => bars);
      expect(w.unavailableReason).toBeNull();
      expect(w.referencePrice).toBe(110); // decision-bar close, not its 100 open
      expect(w.referenceSource).toBe('DECISION_BAR_CLOSE');
      expect(w.decisionBarIso).toBe(`${TRADING_DATE}T09:31:00.000Z`);
      // +5m: bars 09:32..09:36 (5 bars), last close 112 -> (112-110)/110*100
      expect(w.w5m.barsUsed).toBe(5);
      expect(w.w5m.movePct).toBeCloseTo((112 - 110) / 110 * 100, 6);
      expect(w.w5m.endIso).toBe(`${TRADING_DATE}T09:36:00.000Z`);
      // The same-bar +10% move appears nowhere.
      for (const win of [w.w5m, w.w15m, w.w30m, w.w60m, w.close]) {
        expect(win.movePct).not.toBeCloseTo(10, 1);
      }
      // Close window: last bar 15:59 close 120.
      expect(w.close.movePct).toBeCloseTo((120 - 110) / 110 * 100, 6);
      expect(w.close.barsUsed).toBe(8); // 8 strictly-later bars
    });

    it('stored price-at-decision takes precedence as the reference', async () => {
      const bars = [minBar('09:31', 110, 100), minBar('09:32', 112)];
      const w = await mod.computeOutcomeWindows('AAA', `${TRADING_DATE}T09:31:30.000Z`, TRADING_DATE, async () => bars, 105);
      expect(w.referencePrice).toBe(105);
      expect(w.referenceSource).toBe('STORED_PRICE_AT_DECISION');
      expect(w.w5m.movePct).toBeCloseTo((112 - 105) / 105 * 100, 6);
    });

    it('no post-decision bars -> null windows, never fabricated', async () => {
      const bars = [minBar('09:30', 100), minBar('09:31', 110, 100)];
      const w = await mod.computeOutcomeWindows('AAA', `${TRADING_DATE}T09:31:30.000Z`, TRADING_DATE, async () => bars);
      expect(w.unavailableReason).toBe('NO_POST_DECISION_BARS');
      expect(w.w5m.movePct).toBeNull();
      expect(w.close.movePct).toBeNull();
    });

    it('invalid decision timestamp -> null windows with a reason', async () => {
      const w = await mod.computeOutcomeWindows('AAA', 'not-a-time', TRADING_DATE, async () => []);
      expect(w.unavailableReason).toBe('INVALID_DECISION_TIMESTAMP');
    });
  });

  // ------------------------------------------------------------------
  // 3. Discovery-filtered audit (DB)
  // ------------------------------------------------------------------
  describe('auditDiscoveryFiltered', () => {
    it('judges the SPREAD premise correct at decision time and records the +20% rally as outcome context only', async () => {
      sqliteDb.prepare(`INSERT INTO mover_coverage (trading_date, symbol, eod_move_pct, primary_fate, filter_reason, created_at, outcome_windows)
        VALUES (?, 'SPRD', 20.0, 'DISCOVERED_FILTERED', 'SPREAD', ?, ?)`)
        .run(TRADING_DATE, `${TRADING_DATE}T20:00:00.000Z`,
          // Workstream H's pre-existing eod summary block must survive the merge.
          JSON.stringify({ eod: { movePct: 20, referencePrice: 10, dayVolumeShares: 1000000, direction: 'UP' } }));
      const filterTs = Date.parse(`${TRADING_DATE}T09:31:00.000Z`);
      sqliteDb.prepare(`INSERT INTO observability_events (id, ts, level, category, event_type, logger_name, message, session_id, symbol, payload)
        VALUES ('evt-sprd-1', ?, 'info', 'DISCOVERY', 'DISCOVERY_CANDIDATE_FILTERED', 'test', 'filtered', 's1', 'SPRD', ?)`)
        .run(filterTs, JSON.stringify({ reason: 'SPREAD', spreadBps: 250, price: 10, dollarVolume: 40000 }));

      // Recorded bars: decision bar 09:31 closes at 10, later session rallies to 12 (+20%).
      const bars = [minBar('09:31', 10, 9.5), minBar('09:32', 10.5), minBar('10:31', 11), minBar('15:59', 12)];
      const res = await mod.auditDiscoveryFiltered(TRADING_DATE, {
        thresholds: TEST_THRESHOLDS,
        fetchBars: async () => bars,
      });
      expect(res.audited).toBe(1);

      const row = sqliteDb.prepare(`SELECT filter_premise_correct, secondary_reasons, outcome_windows, reference_price
        FROM mover_coverage WHERE trading_date = ? AND symbol = 'SPRD'`).get(TRADING_DATE) as any;
      // Premise judged at decision time: spread 250bps > 100bps ceiling -> correct,
      // DESPITE the +20% later rally.
      expect(row.filter_premise_correct).toBe(1);
      // secondary_reasons keeps its JSON-string-array contract; the audit block
      // is a JSON-encoded string element with a kind discriminator.
      const secondaryRaw = JSON.parse(row.secondary_reasons);
      expect(Array.isArray(secondaryRaw)).toBe(true);
      expect(secondaryRaw.every((x: unknown) => typeof x === 'string')).toBe(true);
      const audit = mod.readAuditNote(row.secondary_reasons, 'discoveryFilterAudit') as any;
      expect(audit).toBeTruthy();
      expect(audit.premiseJudgment.premiseCorrect).toBe(1);
      expect(audit.evidenceSnapshot.spreadBps).toBe(250);
      const windows = JSON.parse(row.outcome_windows);
      expect(windows.referencePrice).toBe(10);
      expect(windows.close.movePct).toBeCloseTo(20, 6); // rally recorded as outcome, verdict untouched
      expect(windows.eod.movePct).toBe(20); // H's pre-existing eod block preserved by the merge
      expect(row.reference_price).toBe(10);
    });
  });

  // ------------------------------------------------------------------
  // 4. Risk-rejected audit (DB)
  // ------------------------------------------------------------------
  describe('auditRiskRejected', () => {
    it('records rejecting gate, decision timestamp, and reference price', async () => {
      sqliteDb.prepare(`INSERT INTO mover_coverage (trading_date, symbol, eod_move_pct, primary_fate, created_at)
        VALUES (?, 'RSKJ', 5.0, 'RISK_REJECTED', ?)`).run(TRADING_DATE, `${TRADING_DATE}T20:00:00.000Z`);
      const decisionIso = `${TRADING_DATE}T10:15:00.000Z`;
      sqliteDb.prepare(`INSERT INTO risk_assessments (transaction_id, trace_id, symbol, side, approved, max_quantity, rejection_gate, reasoning, created_at)
        VALUES ('ARG-2026-10-06-000001', 'trace-risk-1', 'RSKJ', 'BUY', 0, 0, 'MAX_POSITION_SIZE', 'would exceed position cap', ?)`)
        .run(decisionIso);
      sqliteDb.prepare(`INSERT INTO risk_gate_results (trace_id, gate_name, sequence, passed, detail)
        VALUES ('trace-risk-1', 'MAX_POSITION_SIZE', 1, 0, ?)`)
        .run(JSON.stringify({ current: 12, max: 10 }));
      sqliteDb.prepare(`INSERT INTO risk_gate_results (trace_id, gate_name, sequence, passed, detail)
        VALUES ('trace-risk-1', 'FRESH_QUOTE', 2, 1, NULL)`).run();
      sqliteDb.prepare(`INSERT INTO consensus_evidence (transaction_id, agent, side, confidence, weight, agreed, current_price)
        VALUES ('ARG-2026-10-06-000001', 'TechnicalAgent', 'BUY', 0.8, 1.0, 1, 50)`).run();

      const bars = [minBar('10:15', 50, 49), minBar('10:16', 51), minBar('15:59', 55)];
      const res = await mod.auditRiskRejected(TRADING_DATE, { fetchBars: async () => bars });
      expect(res.audited).toBe(1);

      const row = sqliteDb.prepare(`SELECT secondary_reasons, outcome_windows, reference_price
        FROM mover_coverage WHERE trading_date = ? AND symbol = 'RSKJ'`).get(TRADING_DATE) as any;
      const audit = mod.readAuditNote(row.secondary_reasons, 'riskRejectionAudit') as any;
      expect(audit).toBeTruthy();
      expect(audit.firstRejection.rejectionGate).toBe('MAX_POSITION_SIZE');
      expect(audit.firstRejection.decisionAtIso).toBe(decisionIso);
      expect(audit.firstRejection.storedPriceAtDecision).toBe(50);
      expect(audit.firstRejection.gateResults.find((g: any) => g.gateName === 'MAX_POSITION_SIZE').passed).toBe(false);
      expect(audit.referencePrice).toBe(50);
      expect(audit.referenceSource).toBe('STORED_PRICE_AT_DECISION');
      const windows = JSON.parse(row.outcome_windows);
      expect(windows.close.movePct).toBeCloseTo((55 - 50) / 50 * 100, 6);
      expect(row.reference_price).toBe(50);
    });
  });

  // ------------------------------------------------------------------
  // 5. premarket_known_by: 04:00 vs 09:15 sources (DB)
  // ------------------------------------------------------------------
  describe('determinePremarketKnownBy', () => {
    beforeAll(() => {
      // Focus report generated 13:15Z (~09:15 ET): names AAA in PRIMARY, BBB in WATCH.
      sqliteDb.prepare(`INSERT INTO premarket_focus_reports
        (id, plan_date, generated_at, refresh_version, primary_json, secondary_json, watch_json, rejected_json, sources_json, created_at)
        VALUES ('fpr-1', ?, ?, 2, ?, '[]', ?, '[]', '{}', ?)`)
        .run(TRADING_DATE, `${TRADING_DATE}T13:15:00.000Z`,
          JSON.stringify([{ symbol: 'AAA', tier: 'PRIMARY' }]),
          JSON.stringify([{ symbol: 'BBB', tier: 'WATCH' }]),
          `${TRADING_DATE}T13:15:00.000Z`);
      // AAA: 04:00 plan (v1, created 08:00Z - before the focus report).
      sqliteDb.prepare(`INSERT INTO trade_plans
        (id, symbol, plan_date, setup_type, direction, thesis, confidence, evidence_quality, status, created_at, valid_until, refresh_version)
        VALUES ('plan-aaa-1', 'AAA', ?, 'PRIMARY', 'BUY', 'gap thesis', 0.7, 0.8, 'VALID', ?, ?, 1)`)
        .run(TRADING_DATE, `${TRADING_DATE}T08:00:00.000Z`, `${TRADING_DATE}T20:00:00.000Z`);
      // CCC: only a late plan revision (refresh path), no 04:00 plan.
      sqliteDb.prepare(`INSERT INTO trade_plan_revisions
        (id, plan_id, original_plan_id, plan_date, symbol, refresh_version, snapshot_json, created_at)
        VALUES ('rev-ccc-1', 'plan-ccc-1', 'plan-ccc-1', ?, 'CCC', 2, '{}', ?)`)
        .run(TRADING_DATE, `${TRADING_DATE}T13:00:00.000Z`);
      // Fast Lane candidate event for AAA; discovery lineage for AAA and BBB.
      const evt = (id: string, type: string, category: string, sym: string, ts: number) =>
        sqliteDb.prepare(`INSERT INTO observability_events (id, ts, level, category, event_type, logger_name, message, session_id, symbol)
          VALUES (?, ?, 'info', ?, ?, 'test', 'x', 's1', ?)`).run(id, ts, category, type, sym);
      evt('evt-fast-aaa', 'FAST_OPPORTUNITY_DETECTED', 'FAST_LANE', 'AAA', Date.parse(`${TRADING_DATE}T13:30:00.000Z`));
      evt('evt-disc-aaa', 'DISCOVERY_CANDIDATE_ADMITTED', 'DISCOVERY', 'AAA', Date.parse(`${TRADING_DATE}T13:35:00.000Z`));
      evt('evt-disc-bbb', 'DISCOVERY_CANDIDATE_FILTERED', 'DISCOVERY', 'BBB', Date.parse(`${TRADING_DATE}T13:40:00.000Z`));
    });

    it('reads all four sources for a fully-covered symbol', () => {
      const kb = mod.determinePremarketKnownBy('AAA', TRADING_DATE);
      expect(kb.plan0400).toBe(true);
      expect(kb.plan0400At).toBe(`${TRADING_DATE}T08:00:00.000Z`);
      expect(kb.refresh0915).toBe(true); // named in the focus report PRIMARY tier
      expect(kb.fastLane).toBe(true);
      expect(kb.discovery).toBe(true);
      expect(kb.sources).toEqual(expect.arrayContaining(['plan0400', 'refresh0915', 'fastLane', 'discovery']));
    });

    it('a symbol only in the 09:15 report is refresh0915, not plan0400', () => {
      const kb = mod.determinePremarketKnownBy('BBB', TRADING_DATE);
      expect(kb.plan0400).toBe(false);
      expect(kb.refresh0915).toBe(true);
      expect(kb.discovery).toBe(true);
      expect(kb.fastLane).toBe(false);
    });

    it('a late plan revision alone marks refresh0915', () => {
      const kb = mod.determinePremarketKnownBy('CCC', TRADING_DATE);
      expect(kb.plan0400).toBe(false);
      expect(kb.refresh0915).toBe(true);
    });

    it('an unknown symbol has no sources (never fabricated)', () => {
      const kb = mod.determinePremarketKnownBy('ZZZZ', TRADING_DATE);
      expect(kb.sources).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  // 6. Data readiness + session metrics persistence (DB)
  // ------------------------------------------------------------------
  describe('assessDataReadiness + callOutcomeAudits', () => {
    beforeAll(() => {
      // Movers for the metrics: 2 never seen, 1 filtered, 1 risk-rejected, 1 admitted.
      const ins = (sym: string, fate: string, move: number | null) =>
        sqliteDb.prepare(`INSERT INTO mover_coverage (trading_date, symbol, eod_move_pct, primary_fate, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(TRADING_DATE, sym, move, fate, `${TRADING_DATE}T20:00:00.000Z`);
      ins('M1', 'NEVER_SEEN', 12);
      ins('M2', 'NEVER_SEEN', -8);
      ins('M3', 'DISCOVERED_FILTERED', 3);
      ins('M4', 'RISK_REJECTED', -2);
      ins('M5', 'ADMITTED', 6);
      // Lineage filter event for M3 (DOLLAR_VOLUME, below the test floor).
      sqliteDb.prepare(`INSERT INTO observability_events (id, ts, level, category, event_type, logger_name, message, session_id, symbol, payload)
        VALUES ('evt-m3-1', ?, 'info', 'DISCOVERY', 'DISCOVERY_CANDIDATE_FILTERED', 'test', 'filtered', 's1', 'M3', ?)`)
        .run(Date.parse(`${TRADING_DATE}T09:32:00.000Z`), JSON.stringify({ reason: 'DOLLAR_VOLUME', dollarVolume: 10000, price: 5 }));
      // Focus report (latest version) naming M1/M3/M5 across tiers; PRIMARY = AAA(fresh), DDD(denied).
      sqliteDb.prepare(`INSERT INTO premarket_focus_reports
        (id, plan_date, generated_at, refresh_version, primary_json, secondary_json, watch_json, rejected_json, sources_json, created_at)
        VALUES ('fpr-2', ?, ?, 3, ?, ?, ?, '[]', '{}', ?)`)
        .run(TRADING_DATE, `${TRADING_DATE}T13:20:00.000Z`,
          JSON.stringify([
            { symbol: 'AAA', tier: 'PRIMARY', freshness: { dataFresh: true, planStatus: 'VALID' }, subscriptionState: 'SUBSCRIBED_ANCHOR', dataReadiness: { available: ['quote'], missing: [] } },
            { symbol: 'DDD', tier: 'PRIMARY', freshness: { dataFresh: false, planStatus: 'VALID' }, subscriptionState: 'NOT_SUBSCRIBED', dataReadiness: { available: [], missing: ['quote'] } },
          ]),
          JSON.stringify([{ symbol: 'M1', tier: 'SECONDARY' }, { symbol: 'M3', tier: 'SECONDARY' }]),
          JSON.stringify([{ symbol: 'M5', tier: 'WATCH' }]),
          `${TRADING_DATE}T13:20:00.000Z`);
      // DDD's data reservation was denied.
      sqliteDb.prepare(`INSERT INTO premarket_data_reservations
        (id, symbol, tier, requested_at, expires_at, reason, priority, release_condition, status, release_reason, created_at)
        VALUES ('res-ddd-1', 'DDD', 'PRIMARY', ?, ?, 'open coverage', 1, 'market open', 'DENIED', 'capacity exhausted', ?)`)
        .run(`${TRADING_DATE}T12:00:00.000Z`, `${TRADING_DATE}T14:00:00.000Z`, `${TRADING_DATE}T12:05:00.000Z`);
      // M5 got a real quant evaluation and a valid trigger; consensus approved once.
      sqliteDb.prepare(`INSERT INTO quant_assessments (id, symbol, timeframe, regime, market_context, emitted_trade_idea, created_at)
        VALUES ('qa-m5', 'M5', '1Min', '{}', '{}', 0, ?)`).run(`${TRADING_DATE}T14:00:00.000Z`);
      sqliteDb.prepare(`INSERT INTO strategy_engine_signals
        (id, strategy_id, strategy_name, family, symbol, timeframe, evidence_class, side, entry_met, reasons_json, price_at_signal, timestamp, created_at)
        VALUES ('sig-m5', 's1', 'Strat', 'fam', 'M5', '1Min', 'SHADOW', 'BUY', 1, '[]', 20, ?, ?)`)
        .run(Date.parse(`${TRADING_DATE}T14:05:00.000Z`), `${TRADING_DATE}T14:05:00.000Z`);
      sqliteDb.prepare(`INSERT INTO transactions (id, symbol, opened_at, status)
        VALUES ('ARG-2026-10-06-000009', 'M5', ?, 'OPEN')`).run(`${TRADING_DATE}T14:10:00.000Z`);
      sqliteDb.prepare(`INSERT INTO consensus_decisions (transaction_id, symbol, side, weighted_confidence, threshold, approved, created_at)
        VALUES ('ARG-2026-10-06-000009', 'M5', 'BUY', 0.8, 0.75, 1, ?)`).run(`${TRADING_DATE}T14:10:00.000Z`);
      // News coverage for M1 only.
      sqliteDb.prepare(`INSERT INTO observability_events (id, ts, level, category, event_type, logger_name, message, session_id, symbol)
        VALUES ('evt-news-m1', ?, 'info', 'NEWS', 'NEWS_ANALYZED', 'test', 'x', 's1', 'M1')`)
        .run(Date.parse(`${TRADING_DATE}T15:00:00.000Z`));
    });

    it('classifies PRIMARY data readiness with the WHY for failures', () => {
      const { entries, readinessRate } = mod.assessDataReadiness(TRADING_DATE);
      // Two focus reports exist; the latest (refresh_version 3) has AAA + DDD PRIMARY.
      const aaa = entries.find((e) => e.symbol === 'AAA');
      const ddd = entries.find((e) => e.symbol === 'DDD');
      expect(aaa?.readinessClass).toBe('FRESH');
      expect(ddd?.readinessClass).toBe('RESERVATION_DENIED');
      expect(ddd?.why).toContain('capacity exhausted');
      expect(readinessRate).toBeCloseTo(0.5, 6);
    });

    it('persists the full session scorecard per trading date', async () => {
      const bars = [minBar('09:32', 5, 4.8), minBar('15:59', 5.5)];
      const summary = await mod.callOutcomeAudits(TRADING_DATE, {
        thresholds: TEST_THRESHOLDS,
        fetchBars: async () => bars,
      });
      expect(summary.moverCoverageAvailable).toBe(true);
      expect(summary.filteredAudited).toBeGreaterThanOrEqual(1);
      expect(summary.metricsPersisted).toBe(true);

      const row = sqliteDb.prepare(`SELECT * FROM reflection_session_metrics WHERE trading_date = ?`).get(TRADING_DATE) as any;
      expect(row).toBeTruthy();
      // Movers: SPRD, RSKJ (from earlier describes) + M1..M5 = 7 total.
      expect(row.movers_total).toBe(7);
      expect(row.movers_seen).toBe(5);
      expect(row.never_seen_rate).toBeCloseTo(2 / 7, 6);
      expect(row.discovery_filter_rate).toBeCloseTo(2 / 5, 6); // SPRD + M3 of 5 seen
      // Focus recall: latest report (v3) names M1, M3, M5 of 7 movers.
      expect(row.focus_recall).toBeCloseTo(3 / 7, 6);
      // Catalyst coverage: M1 only.
      expect(row.catalyst_coverage).toBeCloseTo(1 / 7, 6);
      // Evaluation: admitted movers = seen minus filtered = RSKJ, M4, M5 (3); evaluated: M5 (1).
      expect(row.evaluation_rate).toBeCloseTo(1 / 3, 6);
      // Valid trigger: M5 triggered.
      expect(row.valid_trigger_rate).toBeCloseTo(1, 6);
      // Consensus: one decision, approved.
      expect(row.consensus_approval_rate).toBeCloseTo(1, 6);
      // Primary precision: latest PRIMARY = {AAA, DDD}; AAA has fast-lane/discovery but no
      // transaction or valid trigger; DDD none -> 0. (Honest zero, not a null.)
      expect(row.primary_precision).toBe(0);
      // Primary data readiness from the readiness assessment.
      expect(row.primary_data_readiness).toBeCloseTo(0.5, 6);
    });

    it('premarket_known_by persists the 4-key boolean contract', async () => {
      const bars = [minBar('09:32', 5, 4.8), minBar('15:59', 5.5)];
      mod.recordPremarketKnownBy(TRADING_DATE);
      // M2 appears in no pre-market source: all-false 4-key contract.
      const row = sqliteDb.prepare(`SELECT premarket_known_by FROM mover_coverage WHERE trading_date = ? AND symbol = 'M2'`).get(TRADING_DATE) as any;
      expect(JSON.parse(row.premarket_known_by)).toEqual({ plan0400: false, refresh0915: false, fastLane: false, discovery: false });
      // M1 is named in the focus report's SECONDARY tier: refresh0915 true.
      const m1 = sqliteDb.prepare(`SELECT premarket_known_by FROM mover_coverage WHERE trading_date = ? AND symbol = 'M1'`).get(TRADING_DATE) as any;
      expect(JSON.parse(m1.premarket_known_by)).toEqual({ plan0400: false, refresh0915: true, fastLane: false, discovery: false });
      // The rich evidence shape stays available programmatically.
      const kb = mod.determinePremarketKnownBy('AAA', TRADING_DATE);
      expect(kb.sources).toEqual(expect.arrayContaining(['plan0400', 'refresh0915', 'fastLane', 'discovery']));
    });

    it('callOutcomeAudits is idempotent per date (upsert, no duplicate rows)', async () => {
      const bars = [minBar('09:32', 5, 4.8), minBar('15:59', 5.5)];
      await mod.callOutcomeAudits(TRADING_DATE, { thresholds: TEST_THRESHOLDS, fetchBars: async () => bars });
      const n = (sqliteDb.prepare(`SELECT COUNT(*) c FROM reflection_session_metrics WHERE trading_date = ?`).get(TRADING_DATE) as any).c;
      expect(n).toBe(1);
    });
  });
});
