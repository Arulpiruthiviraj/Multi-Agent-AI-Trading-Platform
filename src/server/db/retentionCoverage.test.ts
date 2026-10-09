/**
 * Retention coverage guarantee (2026-10-08 "perfect testing" hardening).
 *
 * The defect class: an append-only operational table is added with NO retention sweep,
 * and grows unbounded until a disk-forensics pass finds it. This happened with
 * candidate_rankings (2026-09-22: 1.38M+ rows, zero retention) and again with
 * news_articles / news_clusters (2026-10-08: no prune path anywhere in the codebase).
 *
 * This test makes that class impossible to reintroduce silently:
 * 1. Every known append-only operational table MUST have an entry in RETENTION_SWEEPERS.
 * 2. The scheduler MUST actually invoke every registered sweeper (wiring, not just listing).
 * 3. observability_events (whose sweep lives in its own module) MUST still have its
 *    sweep function and scheduler entry point.
 *
 * Adding a new append-only table without a sweeper fails test 1 by design.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/** Append-only operational tables that must never grow unbounded. */
const REQUIRED_RETENTION_TABLES = [
  'candidate_rankings',
  'trade_plan_revalidations',
  'premarket_data_reservations',
  'news_articles',
  'news_clusters',
  // 2026-10-08 defect hunt (news D2 / infra P2-R1/P2-R3): the coverage test failed by
  // design to catch these - it does now.
  'escalation_decisions',
  'jev_shadow_scores',
  'news_predictions',
  'staged_news_catalysts',
  'ai_calls',
  // 2026-10-08 synthetic session guard: a 6-minute session wrote to these 8
  // tables with no prune path; the session guard test caught them.
  'ohlcv_bars',
  'agent_predictions',
  'quant_assessments',
  'pit_decision_ledger',
  'agent_reasoning_logs',
  'transaction_traces',
  'session_lifecycle_snapshots',
  'trade_lifecycle_transitions',
];

describe('retention coverage', () => {
  let RETENTION_SWEEPERS: Array<{ table: string; sweep: (nowMs?: number) => Promise<number> }>;
  let startOperationalRetentionSweep: () => void;
  let stopOperationalRetentionSweep: () => void;

  beforeAll(async () => {
    ({ RETENTION_SWEEPERS, startOperationalRetentionSweep, stopOperationalRetentionSweep } =
      await import('./operationalRetention'));
  });

  afterAll(() => {
    stopOperationalRetentionSweep();
  });

  it('every known append-only table has a registered sweeper', () => {
    const covered = new Set(RETENTION_SWEEPERS.map((s) => s.table));
    for (const table of REQUIRED_RETENTION_TABLES) {
      expect(covered.has(table), `no retention sweeper registered for ${table}`).toBe(true);
    }
  });

  it('registry entries are unique and well-formed', () => {
    const tables = RETENTION_SWEEPERS.map((s) => s.table);
    expect(new Set(tables).size).toBe(tables.length);
    for (const s of RETENTION_SWEEPERS) {
      expect(typeof s.table).toBe('string');
      expect(s.table.length).toBeGreaterThan(0);
      expect(typeof s.sweep).toBe('function');
    }
  });

  it('the scheduler actually invokes every registered sweeper', async () => {
    stopOperationalRetentionSweep();
    const calls: string[] = [];
    const originals = RETENTION_SWEEPERS.map((s) => ({ ...s }));
    try {
      RETENTION_SWEEPERS.forEach((s, i) => {
        RETENTION_SWEEPERS[i] = {
          table: s.table,
          sweep: async () => { calls.push(s.table); return 0; },
        };
      });
      startOperationalRetentionSweep();
      await new Promise((r) => setTimeout(r, 50));
      expect(calls.sort()).toEqual([...REQUIRED_RETENTION_TABLES].sort());
    } finally {
      originals.forEach((s, i) => { RETENTION_SWEEPERS[i] = s; });
      stopOperationalRetentionSweep();
    }
  });

  it('observability_events keeps its own sweep function and scheduler', async () => {
    const obs = await import('../observability/ObservabilityStore');
    expect(typeof obs.sweepObservabilityRetention).toBe('function');
    expect(typeof obs.startObservabilityRetentionSweep).toBe('function');
    expect(typeof obs.stopObservabilityRetentionSweep).toBe('function');
  });
});
