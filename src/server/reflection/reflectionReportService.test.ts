/**
 * Daily reflection report service tests (2026-10-06, workstream J, local-only).
 *
 * - All 8 report sections assemble correctly from fixture data (pure path,
 *   no DB). Fixture fates use workstream H's real primary_fate taxonomy
 *   (drizzle/0093_mover_coverage.sql) and metrics use workstream I's real
 *   reflection_session_metrics columns (drizzle/0094_reflection_metrics.sql).
 * - Honest empty states: empty fixtures -> hasData=false and the text
 *   renderer says so without throwing (the CLI's exact empty-date path).
 * - The service never mutates the database: snapshot every table's row
 *   count before/after a full report build and require them equal.
 */
import { describe, it, expect } from 'vitest';
import {
  assembleReflectionSections,
  buildDailyReflectionReport,
  formatDailyReflectionReport,
  getMostRecentCompletedTradingDate,
  type FocusPerformanceSection,
  type MoverCoverageRow,
  type ReflectionSessionMetrics,
} from './reflectionReportService';

const NOW = new Date('2026-10-06T21:00:00.000Z');

function mover(partial: Partial<MoverCoverageRow> & { symbol: string }): MoverCoverageRow {
  return {
    tradingDate: '2026-10-05',
    symbol: partial.symbol,
    eodMovePct: null,
    primaryFate: 'UNKNOWN',
    secondaryReasons: [],
    neverSeenCause: null,
    referencePrice: null,
    outcomeWindows: [],
    filterReason: null,
    filterPremiseCorrect: null,
    premarketKnownBy: [],
    ...partial,
  };
}

const FIXTURE_MOVERS: MoverCoverageRow[] = [
  mover({
    symbol: 'AAA',
    eodMovePct: 12.4,
    primaryFate: 'ACTED_ON',
    secondaryReasons: ['CONSENSUS: 0.81 > 0.75', 'CATALYST: earnings beat'],
    outcomeWindows: [{ window: 'T+1d', returnPct: 3.1 }],
    premarketKnownBy: ['catalyst', 'premarket-focus'],
  }),
  mover({
    symbol: 'BBB',
    eodMovePct: -8.2,
    primaryFate: 'CONSENSUS_REJECTED',
    secondaryReasons: ['CONSENSUS: 0.62 < 0.75 — held'],
    outcomeWindows: [{ window: 'T+1d', returnPct: -1.2 }],
  }),
  mover({
    symbol: 'CCC',
    eodMovePct: 9.7,
    primaryFate: 'DISCOVERED_FILTERED',
    filterReason: 'ADV_TOO_LOW',
    filterPremiseCorrect: false,
    secondaryReasons: ['FILTERED: ADV_TOO_LOW'],
  }),
  mover({
    symbol: 'DDD',
    eodMovePct: 6.1,
    primaryFate: 'RISK_REJECTED',
    secondaryReasons: ['RISK: argus_capital_allocation gate failed'],
  }),
  mover({
    symbol: 'EEE',
    eodMovePct: 15.3,
    primaryFate: 'NEVER_SEEN',
    neverSeenCause: 'UNIVERSE_COVERAGE',
    referencePrice: 42.5,
  }),
  mover({
    symbol: 'FFF',
    eodMovePct: 5.5,
    primaryFate: 'NEVER_SEEN',
    neverSeenCause: 'UNIVERSE_COVERAGE',
    referencePrice: 11.0,
  }),
  mover({
    symbol: 'GGG',
    eodMovePct: 4.4,
    primaryFate: 'INSUFFICIENT_EVIDENCE',
    secondaryReasons: ['insufficient evidence: no fresh quote at evaluation'],
  }),
];

const FIXTURE_FOCUS: FocusPerformanceSection = {
  refreshVersion: 3,
  generatedAt: '2026-10-05T13:15:00.000Z',
  candidateCount: 40,
  scoredCount: 38,
  avgTotal: 0.512,
  tierCounts: { PRIMARY: 5, SECONDARY: 10, WATCH: 15, REJECTED: 8 },
  missingInputHistogram: { premarketMove: 2, dollarVolume: 1 },
};

const FIXTURE_METRICS: ReflectionSessionMetrics = {
  tradingDate: '2026-10-05',
  moversTotal: 7,
  moversSeen: 5,
  focusRecall: 0.71,
  primaryDataReadiness: 0.86,
  catalystCoverage: 0.14,
  neverSeenRate: 0.29,
  discoveryFilterRate: 0.14,
  evaluationRate: 0.6,
  validTriggerRate: null,
  consensusApprovalRate: 0.33,
  primaryPrecision: null,
};

function buildFixtureReport() {
  return assembleReflectionSections(
    '2026-10-05',
    FIXTURE_MOVERS,
    FIXTURE_METRICS,
    FIXTURE_FOCUS,
    null,
    true,
    NOW,
  );
}

describe('assembleReflectionSections (fixture data)', () => {
  it('assembles all 8 sections with correct counts', () => {
    const r = buildFixtureReport();
    expect(r.tradingDate).toBe('2026-10-05');
    expect(r.hasData).toBe(true);

    // 1. PREMARKET FOCUS PERFORMANCE
    expect(r.premarketFocusPerformance?.refreshVersion).toBe(3);
    expect(r.premarketFocusPerformance?.tierCounts.PRIMARY).toBe(5);
    expect(r.premarketFocusPerformance?.tierCounts.REJECTED).toBe(8);
    expect(r.premarketFocusPerformance?.missingInputHistogram.premarketMove).toBe(2);

    // 2. DISCOVERY COVERAGE funnel: 7 movers, 5 seen (2 NEVER_SEEN),
    //    3 evaluated (ACTED_ON, CONSENSUS_REJECTED, RISK_REJECTED), 1 acted
    expect(r.discoveryCoverage.funnel).toEqual({ movers: 7, seen: 5, evaluated: 3, acted: 1 });
    expect(r.discoveryCoverage.fateHistogram.NEVER_SEEN).toBe(2);
    expect(r.discoveryCoverage.fateHistogram.ACTED_ON).toBe(1);
    expect(r.discoveryCoverage.sessionMetricsCheck).toEqual({ moversTotal: 7, moversSeen: 5 });
    expect(r.discoveryCoverage.sessionMetricsRates?.focusRecall).toBe(0.71);
    expect(r.discoveryCoverage.sessionMetricsRates?.neverSeenRate).toBe(0.29);

    // 3. NEVER-SEEN MOVERS
    expect(r.neverSeenMovers).toHaveLength(2);
    expect(r.neverSeenMovers.map((m) => m.symbol).sort()).toEqual(['EEE', 'FFF']);
    expect(r.neverSeenMovers[0].cause).toBe('UNIVERSE_COVERAGE');

    // 4. FILTERED WINNERS-LOSERS: CCC premise wrong -> filtered winner
    expect(r.filteredWinnersLosers.filteredCount).toBe(1);
    expect(r.filteredWinnersLosers.premiseWrong).toBe(1);
    expect(r.filteredWinnersLosers.premiseHeld).toBe(0);
    expect(r.filteredWinnersLosers.movers[0].premiseLabel).toBe('winner');
    expect(r.filteredWinnersLosers.movers[0].filterReason).toBe('ADV_TOO_LOW');

    // 5. CONSENSUS REJECTIONS — BBB only; AAA's "CONSENSUS: 0.81 > 0.75"
    //    pass note must NOT count as a rejection
    expect(r.consensusRejections).toHaveLength(1);
    expect(r.consensusRejections[0].symbol).toBe('BBB');
    expect(r.consensusRejections[0].reasons[0]).toContain('0.62');

    // 6. RISK REJECTIONS
    expect(r.riskRejections).toHaveLength(1);
    expect(r.riskRejections[0].symbol).toBe('DDD');

    // 7. DATA-READINESS FAILURES
    expect(r.dataReadinessFailures.movers).toHaveLength(1);
    expect(r.dataReadinessFailures.movers[0].symbol).toBe('GGG');
    expect(r.dataReadinessFailures.focusMissingInputs.premarketMove).toBe(2);
    expect(r.dataReadinessFailures.sessionMetricsPrimaryDataReadiness).toBe(0.86);

    // 8. CATALYST COVERAGE: only AAA has catalyst evidence
    expect(r.catalystCoverage.withCatalyst).toBe(1);
    expect(r.catalystCoverage.withoutCatalyst).toBe(6);
    expect(r.catalystCoverage.withCatalystSymbols).toEqual(['AAA']);
  });

  it('derives repeating issues as observed patterns, never inventing issue text', () => {
    const r = buildFixtureReport();
    expect(r.repeatingIssues).toHaveLength(1);
    expect(r.repeatingIssues[0]).toContain('UNIVERSE_COVERAGE');
    expect(r.repeatingIssues[0]).toContain('2 movers');
  });

  it('sorts the mover list by |eod_move_pct| desc for drill-down', () => {
    const r = buildFixtureReport();
    expect(r.movers.map((m) => m.symbol)[0]).toBe('EEE'); // |15.3| largest
    expect(r.movers).toHaveLength(7);
  });

  it('honest empty report when nothing is loaded', () => {
    const r = assembleReflectionSections('2026-10-05', [], null, null, null, false, NOW);
    expect(r.hasData).toBe(false);
    expect(r.sources.moverCoverageTablePresent).toBe(false);
    expect(r.neverSeenMovers).toEqual([]);
    expect(r.consensusRejections).toEqual([]);
    expect(r.movers).toEqual([]);
    expect(r.repeatingIssues).toEqual([]);
  });
});

describe('formatDailyReflectionReport', () => {
  it('renders all section headers on fixture data', () => {
    const text = formatDailyReflectionReport(buildFixtureReport());
    for (const header of [
      'PREMARKET FOCUS PERFORMANCE',
      'DISCOVERY COVERAGE',
      'NEVER-SEEN MOVERS',
      'FILTERED WINNERS-LOSERS',
      'CONSENSUS REJECTIONS',
      'RISK REJECTIONS',
      'DATA-READINESS FAILURES',
      'CATALYST COVERAGE',
      'TOP MOVERS',
      'REPEATING ISSUES',
    ]) {
      expect(text).toContain(header);
    }
    expect(text).toContain('AAA');
    expect(text).toContain('FILTERED WINNER');
    expect(text).toContain('focusRecall=71.0%');
  });

  it('renders honest no-data output on an empty date without throwing', () => {
    const r = assembleReflectionSections('2099-01-01', [], null, null, null, false, NOW);
    let text = '';
    expect(() => {
      text = formatDailyReflectionReport(r);
    }).not.toThrow();
    expect(text).toContain('No reflection data for 2099-01-01 yet');
    expect(text).toContain('mover_coverage table not present yet (workstream H)');
    expect(text).not.toContain('AAA');
  });
});

describe('buildDailyReflectionReport (DB path)', () => {
  it('rejects a malformed date', async () => {
    await expect(buildDailyReflectionReport('not-a-date')).rejects.toThrow('YYYY-MM-DD');
  });

  it('returns an honest empty report for a date with no rows', async () => {
    const r = await buildDailyReflectionReport('2099-01-01');
    expect(r.tradingDate).toBe('2099-01-01');
    expect(r.hasData).toBe(false);
    expect(r.movers).toEqual([]);
  }, 30000);

  it('never mutates the database (row counts identical before/after)', async () => {
    const { sqliteDb } = await import('../db');
    // Warm-up: trigger every lazy import this service uses. src/server/db
    // seeds ai_models asynchronously at module load (fire-and-forget), so
    // wait for that background seeding to settle before snapshotting —
    // otherwise the seed's own inserts would be misattributed to the service.
    await buildDailyReflectionReport('2099-01-01');
    const count = (t: string): number =>
      (sqliteDb.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    for (let i = 0; i < 40 && count('ai_models') < 6; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const snapshot = (): Record<string, number> => {
      const tables = sqliteDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const counts: Record<string, number> = {};
      for (const t of tables) counts[t.name] = count(t.name);
      return counts;
    };
    const before = snapshot();
    await buildDailyReflectionReport('2099-01-01');
    await buildDailyReflectionReport('2026-10-05');
    const after = snapshot();
    expect(after).toEqual(before);
  }, 60000);

  it('getMostRecentCompletedTradingDate falls back honestly on an empty DB', async () => {
    const d = await getMostRecentCompletedTradingDate();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(d).toBe(yesterday);
  });
});
