// LABEL: SOAK - resource-bounds guard across one synthetic session (retention story for every written table; event-loop p99 bound). Proves resource-hygiene properties of the synthetic harness; does NOT prove production data availability or strategy behavior.
/**
 * SYNTHETIC SESSION GUARDS (2026-10-08).
 *
 * === SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY ===
 *
 * Why this exists: on 2026-10-08 we discovered news_articles/news_clusters had
 * grown on disk with no retention path anywhere in the codebase — and NO
 * synthetic test caught it, because every synthesis test asserted DECISIONS
 * (ideas -> risk -> orders -> fills) while no test asserted RESOURCE BOUNDS.
 * A table with no prune path passes every feature test while the disk fills
 * silently. That class of miss must fail loudly from now on.
 *
 * This test runs one real synthetic session (real core, real EventBus, real
 * spine — same harness as SyntheticSessionEngine.sessionTeardown.test.ts) and
 * asserts two session-level guards:
 *
 *  1. STORAGE GUARD: every table that received rows during the session must
 *     have a bounded-growth story — either a registered retention sweeper
 *     (RETENTION_SWEEPERS), the observability sweep, or the explicit
 *     permanent-record allowlist (trades/fills/risk_assessments/event_traces/
 *     transactions, deliberately never pruned per the codebase's own
 *     comments). A table with rows and no story fails with its name.
 *  2. EVENT-LOOP GUARD: session p99 event-loop delay stays under a generous
 *     bound. The October-8 backup defect blocked the loop for minutes; a
 *     session that stalls the loop this badly fails here instead of hiding
 *     inside a green suite.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SyntheticSessionEngine } from './SyntheticSessionEngine';

/** Tables deliberately never pruned: the permanent decision record. */
const PERMANENT_TABLES = new Set([
  'trades',
  'fills',
  'risk_assessments',
  'event_traces',
  'transactions',
]);

/**
 * Tables that cannot grow unbounded by construction: migration ledger (not
 * application data), config/registry tables, per-agent aggregates keyed by
 * agent_name, and singleton state rows. Documented here so the guard's failure
 * output stays focused on genuine growth risks.
 */
const BOUNDED_TABLES = new Set([
  '__drizzle_migrations',
  'ai_models',
  'ai_providers',
  'settings',
  'agent_performance_stats', // PK agent_name: one row per agent
  'crypto_paper_broker_state', // PK literal 'singleton': one row
]);

/** Generous: a healthy session never approaches this; the backup defect hit minutes. */
const EVENT_LOOP_P99_BOUND_MS = 2000;

describe('synthetic session guards (SYNTHETIC_SEEDED)', () => {
  it('every table the session writes has a bounded-growth story; event loop stays healthy', async () => {
    const simId = `session-guard-${Date.now()}`;
    const engine = new SyntheticSessionEngine();
    engine.prepareIsolatedEnvironment({ simulationId: simId, scenarioId: 'QUIET_OPEN', seed: 777 });
    // Import AFTER prepareIsolatedEnvironment (engine contract: env first, then
    // real modules). We only read the registry; no DB writes through it.
    const { RETENTION_SWEEPERS } = await import('../../db/operationalRetention');
    const sweptTables = new Set(RETENTION_SWEEPERS.map((s) => s.table));
    sweptTables.add('observability_events'); // own sweeper in ObservabilityStore

    const result = await engine.run({
      simulationId: simId,
      scenarioId: 'QUIET_OPEN',
      seed: 777,
      speedMultiplier: 30,
      sessionDurationMinutes: 6,
      universeSize: 3,
      initialCash: 100_000,
    } as const);

    // Guard 1: storage.
    const db = new Database(result.dbPath, { readonly: true });
    try {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>;
      const uncovered: Array<{ table: string; rows: number }> = [];
      for (const { name } of tables) {
        const { c } = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number };
        if (c > 0 && !sweptTables.has(name) && !PERMANENT_TABLES.has(name) && !BOUNDED_TABLES.has(name)) {
          uncovered.push({ table: name, rows: c });
        }
      }
      expect(
        uncovered,
        `tables grew with no retention story: ${JSON.stringify(uncovered)} — ` +
          `register a sweeper in RETENTION_SWEEPERS or document permanent status`,
      ).toEqual([]);
    } finally {
      db.close();
    }

    // Guard 2: event loop.
    expect(result.eventLoopP99Ms).not.toBeNull();
    expect(result.eventLoopP99Ms as number).toBeLessThan(EVENT_LOOP_P99_BOUND_MS);
  }, 300000);
}, 300000);
