/**
 * Tests for the pre-market focus report (workstream D): tiering from fixture
 * plans, honest missing-input handling, persistence round-trip (the CLI's
 * read path), per-candidate event emission, and the defensive refresh
 * subscriber. DB-isolated via a temp ARGUS_DB_PATH (same convention as
 * SessionLifecycle.test.ts) — never touches the real data/argus.db.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildFocusReport,
  getPersistedFocusReport,
  getPlanTierMovements,
  getPremarketFocusCliView,
  getPremarketLifecycleStatusSafe,
  formatPremarketRvol,
  planRvolDisplayLine,
  tierForTotal,
  type TradePlanRow,
} from './PremarketFocusReport';
import { installPremarketFocusSubscribers, PREMARKET_CANDIDATE_SCORED, PREMARKET_REFRESH_COMPLETED } from './premarketFocusEvents';
import { eventBus } from '../core/EventBus';
import { premarketFocusConfig } from '../config/premarketFocus';
import type { PremarketCandidateInput, PremarketScoreBreakdown } from './PremarketOpportunityScore';

const TRADING_DATE = '2026-10-06';
const NOW = new Date('2026-10-06T12:00:00.000Z'); // 08:00 ET
const VALID_UNTIL = '2026-10-06T20:00:00.000Z'; // 16:00 ET
const CREATED_AT = '2026-10-06T08:00:00.000Z';

function planRow(overrides: Partial<TradePlanRow> = {}): TradePlanRow {
  const base: TradePlanRow = {
    id: `plan-${overrides.symbol ?? 'X'}`,
    symbol: 'X',
    planDate: TRADING_DATE,
    setupType: 'WATCHLIST',
    direction: 'BUY',
    thesis: 'fixture thesis',
    catalysts: null,
    catalystType: null,
    catalystSourceCount: null,
    entryZoneLow: null,
    entryZoneHigh: null,
    invalidationLevel: null,
    targetConcept: null,
    confidence: 0.5,
    confluenceScore: 0.5,
    evidenceQuality: 0.5,
    rankAtCreation: 99,
    componentScoresJson: null,
    status: 'READY',
    createdAt: CREATED_AT,
    validUntil: VALID_UNTIL,
    validUntilConfidence: null,
    refreshVersion: 1,
    refreshedAt: null,
    reasonForRefresh: null,
    originalCreatedAt: null,
    scoreDecompositionJson: null,
    evidenceAsof: null,
    sessionPhase: null,
  };
  return { ...base, ...overrides };
}

function persistedBreakdown(symbol: string, total: number): string {
  const zero = {
    overnightGap: 0, preMarketPctChange: 0, catalystPresence: 0, catalystRecency: 0,
    signedSentiment: 0, liquidity: 0, spreadQuality: 1, sectorRelativeStrength: 0,
    marketRelativeStrength: 0, strategyApplicability: 0,
  };
  const breakdown: PremarketScoreBreakdown = {
    symbol,
    components: zero,
    total,
    weights: { ...premarketFocusConfig.weights },
    scoredAt: NOW.toISOString(),
    inputsAvailable: ['dataFresh', 'spreadBps'],
    inputsMissing: ['catalyst'],
  };
  return JSON.stringify(breakdown);
}

function fixturePlans(): TradePlanRow[] {
  return [
    planRow({
      id: 'plan-aaa', symbol: 'AAA', setupType: 'PRIMARY', rankAtCreation: 1,
      catalysts: JSON.stringify(['earnings beat']), catalystType: 'EARNINGS', catalystSourceCount: 3,
      confluenceScore: 0.8, confidence: 0.85,
    }),
    planRow({
      id: 'plan-bbb', symbol: 'BBB', setupType: 'BACKUP', rankAtCreation: 4,
      catalysts: JSON.stringify(['analyst upgrade']), catalystType: 'ANALYST', catalystSourceCount: 1,
      confluenceScore: 0.6,
    }),
    planRow({
      id: 'plan-ccc', symbol: 'CCC', setupType: 'WATCHLIST', rankAtCreation: 9,
      catalysts: JSON.stringify([]), confluenceScore: 0.4,
    }),
    // DDD: no explicit candidate inputs -> default honest-missing derivation.
    planRow({ id: 'plan-ddd', symbol: 'DDD', rankAtCreation: 12, confluenceScore: 0.3 }),
    // EEE: persisted breakdown from workstream B's refresh -> used as-is.
    planRow({
      id: 'plan-eee', symbol: 'EEE', setupType: 'PRIMARY', rankAtCreation: 2,
      scoreDecompositionJson: persistedBreakdown('EEE', 0.9),
    }),
    // FFF: corrupt persisted breakdown -> falls back to default derivation, never throws.
    planRow({ id: 'plan-fff', symbol: 'FFF', rankAtCreation: 15, scoreDecompositionJson: 'not-json{{{' }),
  ];
}

/** Rich inputs: total ≈ 0.866 -> PRIMARY. Moderate: ≈ 0.542 -> SECONDARY. Weak: ≈ 0.358 -> WATCH. */
function fixtureInputs(): Map<string, PremarketCandidateInput> {
  return new Map<string, PremarketCandidateInput>([
    ['AAA', {
      symbol: 'AAA', overnightGapPct: 4, preMarketPctChange: 3,
      catalyst: { sentiment: 1, confidence: 0.9, recencyMinutes: 30, source: 'rss:test', impactMagnitude: 0.8 },
      dollarVolume: 60_000_000, spreadBps: 5,
      sectorRelativeStrength: 0.8, marketRelativeStrength: 0.7,
      strategyApplicability: ['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'TREND_FOLLOWING'],
      dataFresh: true,
    }],
    ['BBB', {
      symbol: 'BBB', overnightGapPct: 3, preMarketPctChange: 1.5,
      catalyst: { sentiment: 0, confidence: 0.5, recencyMinutes: 120, source: 'rss:test', impactMagnitude: 0.4 },
      dollarVolume: 20_000_000, spreadBps: null,
      sectorRelativeStrength: 0.5, marketRelativeStrength: 0.5,
      strategyApplicability: ['MOMENTUM_BREAKOUT'],
      dataFresh: true,
    }],
    ['CCC', {
      symbol: 'CCC', overnightGapPct: 1, preMarketPctChange: 0.5,
      catalyst: { sentiment: 0, confidence: 0.3, recencyMinutes: 700, source: 'rss:test', impactMagnitude: 0.2 },
      dollarVolume: 10_000_000, spreadBps: null,
      sectorRelativeStrength: 0.9, marketRelativeStrength: 0.9,
      strategyApplicability: [],
      dataFresh: true,
    }],
  ]);
}

describe('tierForTotal', () => {
  it('tiers from the config cutoffs (tests read the same config as production)', () => {
    const { primary, secondary, watch } = premarketFocusConfig.tierCutoffs;
    expect(tierForTotal(primary)).toBe('PRIMARY');
    expect(tierForTotal(primary - 0.001)).toBe('SECONDARY');
    expect(tierForTotal(secondary)).toBe('SECONDARY');
    expect(tierForTotal(watch)).toBe('WATCH');
    expect(tierForTotal(watch - 0.001)).toBe('REJECTED');
    expect(tierForTotal(0)).toBe('REJECTED');
  });
});

/** File-level DB isolation: one temp DB for the whole file (the db module is
 *  cached after first import, so a second per-describe ARGUS_DB_PATH would
 *  silently keep pointing at the first DB). Same convention as
 *  SessionLifecycle.test.ts — never touches the real data/argus.db. */
let tmpDbPath: string;
let sqliteDb: { close(): void };

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `argus_premarket_focus_${Date.now()}_${process.pid}.db`);
  process.env.ARGUS_DB_PATH = tmpDbPath;
  const dbMod = await import('../db');
  sqliteDb = dbMod.sqliteDb as { close(): void };
  const schema = await import('../db/schema');
  await dbMod.db.insert(schema.tradePlans).values(fixturePlans());
  // Warm the heavy MarketDataWorker module graph once here (hookTimeout is
  // 60s): buildFocusReport resolves subscription state via a dynamic import
  // of it, and the first import takes several seconds in the test env.
  await import('../services/MarketDataWorker');
}, 60_000);

afterAll(() => {
  try { sqliteDb.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
  }
  delete process.env.ARGUS_DB_PATH;
});

describe('buildFocusReport — tiering from fixture plans', () => {
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitSpy = vi.spyOn(eventBus, 'emit');
  });

  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('tiers candidates PRIMARY / SECONDARY / WATCH / REJECTED from fixture plans', async () => {
    const report = await buildFocusReport(TRADING_DATE, 1, {
      plans: fixturePlans(),
      candidateInputs: fixtureInputs(),
      now: NOW,
      refreshedAt: '2026-10-06T12:05:00.000Z',
    });

    expect(report.tradingDate).toBe(TRADING_DATE);
    expect(report.refreshVersion).toBe(1);
    expect(report.tiers.PRIMARY.map((e) => e.symbol)).toEqual(['EEE', 'AAA']); // total desc
    expect(report.tiers.SECONDARY.map((e) => e.symbol)).toEqual(['BBB']);
    expect(report.tiers.WATCH.map((e) => e.symbol)).toEqual(['CCC']);
    expect(report.tiers.REJECTED.map((e) => e.symbol)).toEqual(['DDD', 'FFF']); // tie at 0.05 -> symbol asc

    const aaa = report.tiers.PRIMARY.find((e) => e.symbol === 'AAA')!;
    expect(aaa.total).toBeCloseTo(0.8658, 3);
    expect(aaa.total).toBeGreaterThanOrEqual(premarketFocusConfig.tierCutoffs.primary);
    const bbb = report.tiers.SECONDARY[0];
    expect(bbb.total).toBeCloseTo(0.5417, 3);
    const ccc = report.tiers.WATCH[0];
    expect(ccc.total).toBeCloseTo(0.3578, 3);
  });

  it('per-symbol entries carry why-selected, catalyst, freshness, strategy applicability, data readiness, subscription state — and no direction', async () => {
    const report = await buildFocusReport(TRADING_DATE, 1, {
      plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW,
    });
    const aaa = report.tiers.PRIMARY.find((e) => e.symbol === 'AAA')!;

    expect(aaa.whySelected.length).toBeGreaterThan(0);
    expect(aaa.whySelected.some((r) => r.includes('overnight gap +4.00%'))).toBe(true);
    expect(aaa.catalyst).toMatchObject({ labels: ['earnings beat'], type: 'EARNINGS', sourceCount: 3, scored: true });
    expect(aaa.freshness).toMatchObject({ planStatus: 'READY', dataFresh: true });
    expect(aaa.freshness.planAgeMinutes).toBe(240); // 08:00 -> 12:00 UTC
    expect(aaa.strategyApplicability).toHaveLength(3);
    // 9 of 10 scored inputs present; advShares honestly missing from the fixture.
    expect(aaa.dataReadiness.completeness).toBeCloseTo(0.9, 10);
    expect(aaa.dataReadiness.missing).toEqual(['advShares']);
    expect(['SUBSCRIBED_ANCHOR', 'SUBSCRIBED_DYNAMIC', 'NOT_SUBSCRIBED', 'UNKNOWN']).toContain(aaa.subscriptionState);

    // Never actionable: no direction/side anywhere in the entry or its JSON.
    const serialized = JSON.stringify(aaa);
    expect(serialized).not.toContain('BUY');
    expect(serialized).not.toContain('SELL');
    expect('direction' in aaa).toBe(false);
    expect('side' in aaa).toBe(false);
  });

  it('default derivation (no explicit inputs) is honest: REJECTED with missing inputs listed', async () => {
    const report = await buildFocusReport(TRADING_DATE, 1, { plans: fixturePlans(), now: NOW });
    const ddd = report.tiers.REJECTED.find((e) => e.symbol === 'DDD')!;
    // Only the fail-open spread contributes: 0.05 x 1.0.
    expect(ddd.total).toBeCloseTo(premarketFocusConfig.weights.spreadQuality, 10);
    expect(ddd.inputsMissing).toContain('overnightGapPct');
    expect(ddd.inputsMissing).toContain('catalyst');
    expect(ddd.inputsMissing).toContain('dollarVolume');
    expect(ddd.whySelected[0]).toContain('below WATCH cutoff');
    expect(ddd.dataReadiness.completeness).toBeLessThan(0.5);
  });

  it('uses the persisted refresh breakdown when present; corrupt JSON falls back without throwing', async () => {
    const report = await buildFocusReport(TRADING_DATE, 1, { plans: fixturePlans(), now: NOW });
    const eee = report.tiers.PRIMARY.find((e) => e.symbol === 'EEE')!;
    expect(eee.total).toBe(0.9);
    expect(eee.whySelected).toContain('score from persisted refresh breakdown');
    const fff = report.tiers.REJECTED.find((e) => e.symbol === 'FFF')!;
    expect(fff.total).toBeCloseTo(premarketFocusConfig.weights.spreadQuality, 10);
  });

  it('emits one bounded PREMARKET_CANDIDATE_SCORED per candidate', async () => {
    await buildFocusReport(TRADING_DATE, 1, { plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW });
    const scored = emitSpy.mock.calls.filter(([event]) => event === PREMARKET_CANDIDATE_SCORED);
    expect(scored).toHaveLength(6);
    for (const [, payload] of scored) {
      expect(typeof payload.symbol).toBe('string');
      expect(typeof payload.total).toBe('number');
      expect(payload.topContributions.length).toBeLessThanOrEqual(premarketFocusConfig.report.topContributionsKept);
      expect(Array.isArray(payload.inputsMissing)).toBe(true);
    }
    const aaaPayload = scored.find(([, p]) => p.symbol === 'AAA')![1];
    expect(aaaPayload.tier).toBe('PRIMARY');
    expect(aaaPayload.tradingDate).toBe(TRADING_DATE);
    expect(aaaPayload.refreshVersion).toBe(1);
  });

  it('persists the report; getPersistedFocusReport (the CLI read path) returns it', async () => {
    const built = await buildFocusReport(TRADING_DATE, 7, {
      plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW,
      refreshedAt: '2026-10-06T12:05:00.000Z',
    });
    const read = await getPersistedFocusReport(TRADING_DATE, 7);
    expect(read).not.toBeNull();
    expect(read!.tradingDate).toBe(TRADING_DATE);
    expect(read!.refreshVersion).toBe(7);
    expect(read!.refreshedAt).toBe('2026-10-06T12:05:00.000Z');
    expect(read!.tiers.PRIMARY.map((e) => e.symbol)).toEqual(built.tiers.PRIMARY.map((e) => e.symbol));
    expect(read!.tiers.REJECTED.map((e) => e.symbol)).toEqual(built.tiers.REJECTED.map((e) => e.symbol));
    expect(read!.metrics.candidateCount).toBe(6);
    expect(read!.sources.symbolsScored).toBe(6);
    // The persisted JSON never implies actionable either.
    expect(JSON.stringify(read)).not.toContain('BUY');
    expect(JSON.stringify(read)).not.toContain('SELL');
  });

  it('rebuild for the same (date, version) upserts instead of duplicating', async () => {
    await buildFocusReport(TRADING_DATE, 9, { plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW });
    await buildFocusReport(TRADING_DATE, 9, { plans: fixturePlans(), candidateInputs: fixtureInputs(), now: NOW });
    const read = await getPersistedFocusReport(TRADING_DATE, 9);
    expect(read).not.toBeNull();
    expect(read!.metrics.candidateCount).toBe(6);
  });

  it('returns null when no report exists for the date', async () => {
    expect(await getPersistedFocusReport('2099-01-01')).toBeNull();
  });
});

describe('RVOL honesty — PREMARKET_RVOL_UNAVAILABLE (workstream E verdict)', () => {
  it('formatPremarketRvol maps null/zero/non-positive to PREMARKET_RVOL_UNAVAILABLE, never "0.00x"', () => {
    for (const bad of [null, undefined, 0, -1, -0.5, NaN, Infinity]) {
      const rendered = formatPremarketRvol(bad as number | null | undefined);
      expect(rendered).toBe('PREMARKET_RVOL_UNAVAILABLE');
      expect(rendered).not.toContain('0.00x');
    }
  });

  it('formatPremarketRvol renders a real positive multiple honestly', () => {
    expect(formatPremarketRvol(2.345)).toBe('2.35x');
    expect(formatPremarketRvol(0.5)).toBe('0.50x');
  });

  it('planRvolDisplayLine returns null when the plan carries no RVOL evidence', () => {
    expect(planRvolDisplayLine(planRow({ componentScoresJson: null }))).toBeNull();
    expect(planRvolDisplayLine(planRow({ componentScoresJson: 'not-json' }))).toBeNull();
    expect(planRvolDisplayLine(planRow({ componentScoresJson: JSON.stringify({ momentum: { score: 0.5 } }) }))).toBeNull();
  });

  it('unavailable RVOL in the focus report renders PREMARKET_RVOL_UNAVAILABLE, never "0.00x"', async () => {
    const ggg = planRow({
      id: 'plan-ggg', symbol: 'GGG', rankAtCreation: 20,
      componentScoresJson: JSON.stringify({
        relativeVolume: { score: null, available: false, reason: 'no premarket time-of-day curve' },
        momentum: { score: 0.5, available: true },
      }),
    });
    const report = await buildFocusReport(TRADING_DATE, 1, { plans: [ggg], now: NOW });
    const entry = report.tiers.REJECTED.find((e) => e.symbol === 'GGG')!;
    expect(entry).toBeDefined();
    expect(entry.whySelected.some((r) => r.includes('PREMARKET_RVOL_UNAVAILABLE'))).toBe(true);
    expect(entry.whySelected.some((r) => r.includes('0.00x'))).toBe(false);
    // The persisted JSON carries the honest marker too.
    const read = await getPersistedFocusReport(TRADING_DATE, 1);
    const persisted = read!.tiers.REJECTED.find((e) => e.symbol === 'GGG')!;
    expect(JSON.stringify(persisted.whySelected)).toContain('PREMARKET_RVOL_UNAVAILABLE');
    expect(JSON.stringify(persisted.whySelected)).not.toContain('0.00x');
  });

  it('available RVOL renders its real normalized score, honestly labeled', async () => {
    const hhh = planRow({
      id: 'plan-hhh', symbol: 'HHH', rankAtCreation: 21,
      componentScoresJson: JSON.stringify({
        relativeVolume: { score: 0.75, available: true },
      }),
    });
    const report = await buildFocusReport(TRADING_DATE, 1, { plans: [hhh], now: NOW });
    const entry = report.tiers.REJECTED.find((e) => e.symbol === 'HHH')!;
    expect(entry.whySelected.some((r) => r === 'relative volume score 0.75')).toBe(true);
  });
});

describe('getPremarketLifecycleStatusSafe — workstream B contract', () => {
  it('returns B\'s lifecycle status when available; degrades to null (never throws) otherwise', async () => {
    const status = await getPremarketLifecycleStatusSafe(TRADING_DATE);
    // Workstream B has landed getPremarketLifecycleStatus: expect the real,
    // shape-validated status. The safe wrapper still guarantees null-or-valid.
    expect(status).not.toBeNull();
    expect(status!.tradingDate).toBe(TRADING_DATE);
    expect(typeof status!.sessionPhase).toBe('string');
    expect(typeof status!.refreshDue).toBe('boolean');
    const pc = status!.planCounts;
    expect(Object.values(pc).reduce((a, b) => a + b, 0)).toBe(6); // 6 fixture plans
    expect(pc.PRIMARY).toBe(2);
    expect(pc.BACKUP).toBe(1);
    expect(pc.WATCH).toBe(3);
  });

  it('never rejects', async () => {
    await expect(getPremarketLifecycleStatusSafe('2099-01-01')).resolves.not.toThrow();
  });
});

describe('getPlanTierMovements — promotions/downgrades/expiries since the previous build', () => {
  const MOVEMENT_DATE = '2026-10-07';

  beforeAll(async () => {
    const dbMod = await import('../db');
    const schema = await import('../db/schema');
    const v1 = ['AAA', 'BBB', 'CCC', 'DDD'].map((s, i) =>
      planRow({
        id: `m1-${s}`, symbol: s, planDate: MOVEMENT_DATE, refreshVersion: 1, rankAtCreation: i + 1,
        setupType: s === 'AAA' ? 'PRIMARY' : s === 'BBB' ? 'BACKUP' : 'WATCHLIST',
      }),
    );
    const v2 = [
      planRow({ id: 'm2-AAA', symbol: 'AAA', planDate: MOVEMENT_DATE, refreshVersion: 2, rankAtCreation: 1, setupType: 'PRIMARY' }),
      planRow({ id: 'm2-BBB', symbol: 'BBB', planDate: MOVEMENT_DATE, refreshVersion: 2, rankAtCreation: 5, setupType: 'WATCHLIST' }),
      planRow({ id: 'm2-DDD', symbol: 'DDD', planDate: MOVEMENT_DATE, refreshVersion: 2, rankAtCreation: 3, setupType: 'BACKUP' }),
      planRow({ id: 'm2-EEE', symbol: 'EEE', planDate: MOVEMENT_DATE, refreshVersion: 2, rankAtCreation: 2, setupType: 'PRIMARY' }),
    ];
    await dbMod.db.insert(schema.tradePlans).values([...v1, ...v2]);
  });

  it('detects promotions, downgrades, and expiries between the two latest versions', async () => {
    const { currentVersion, previousVersion, movements } = await getPlanTierMovements(MOVEMENT_DATE);
    expect(currentVersion).toBe(2);
    expect(previousVersion).toBe(1);
    expect(movements).toEqual([
      { symbol: 'BBB', kind: 'DOWNGRADED', from: 'BACKUP', to: 'WATCHLIST' },
      { symbol: 'CCC', kind: 'EXPIRED', from: 'WATCHLIST', to: null },
      { symbol: 'DDD', kind: 'PROMOTED', from: 'WATCHLIST', to: 'BACKUP' },
    ]);
  });

  it('returns empty movements when fewer than two versions exist', async () => {
    const res = await getPlanTierMovements(TRADING_DATE);
    expect(res.currentVersion).toBe(1);
    expect(res.previousVersion).toBeNull();
    expect(res.movements).toEqual([]);
  });
});

describe('getPremarketFocusCliView — CLI service function', () => {
  it('assembles lifecycle (degraded), per-symbol plan rows, movements, and the persisted report', async () => {
    const view = await getPremarketFocusCliView(TRADING_DATE, NOW);
    expect(view.tradingDate).toBe(TRADING_DATE);
    // Workstream B's getPremarketLifecycleStatus is landed: real status, shape-validated.
    expect(view.lifecycle).not.toBeNull();
    expect(view.lifecycle!.tradingDate).toBe(TRADING_DATE);
    expect(typeof view.lifecycle!.sessionPhase).toBe('string');
    expect(typeof view.lifecycle!.refreshDue).toBe('boolean');
    expect(view.plans).toHaveLength(6);
    // Lifecycle-tier sort: PRIMARY first.
    expect(view.plans[0].setupType).toBe('PRIMARY');
    const aaa = view.plans.find((p) => p.symbol === 'AAA')!;
    expect(aaa).toMatchObject({ direction: 'BUY', planVersion: 1, setupType: 'PRIMARY' });
    expect(aaa.planAgeMinutes).toBe(240);
    expect(aaa.catalystLabels).toEqual(['earnings beat']);
    expect(aaa.dataTotal).toBeGreaterThan(0);
    expect(typeof aaa.total).toBe('number');
    expect(aaa.whySelected.length).toBeGreaterThan(0);
    // Movements: only v1 exists for this date.
    expect(view.movementVersions).toEqual({ current: 1, previous: null });
    expect(view.movements).toEqual([]);
    // Persisted focus report from the earlier build tests.
    expect(view.focusReport).not.toBeNull();
    expect(view.focusReport!.tiers.PRIMARY.length).toBeGreaterThan(0);
  });
});

describe('CLI wiring — argus premarket-focus', () => {
  it('is registered with a Usage: help entry', async () => {
    const cli = await import('../../../scripts/argus-cli');
    expect(cli.commandNames()).toContain('premarket-focus');
    expect(cli.COMMAND_HELP['premarket-focus'].startsWith('Usage:')).toBe(true);
    expect(cli.COMMAND_HELP['premarket-focus']).toContain('--date=');
  });
});

describe('installPremarketFocusSubscribers — defensive refresh handling', () => {
  let unsubscribe: () => void;

  beforeAll(() => {
    unsubscribe = installPremarketFocusSubscribers();
  });

  afterAll(() => {
    unsubscribe();
  });

  it('regenerates the report on PREMARKET_REFRESH_COMPLETED without throwing', async () => {
    expect(() =>
      eventBus.emit(PREMARKET_REFRESH_COMPLETED, {
        tradingDate: TRADING_DATE,
        refreshVersion: 2,
        refreshedAt: '2026-10-06T13:00:00.000Z',
        planCount: 6,
        at: '2026-10-06T13:00:00.000Z',
      }),
    ).not.toThrow();

    // The subscriber builds async; poll for the persisted v2 report.
    let read = null;
    for (let i = 0; i < 50 && !read; i++) {
      await new Promise((r) => setTimeout(r, 100));
      read = await getPersistedFocusReport(TRADING_DATE, 2);
    }
    expect(read).not.toBeNull();
    expect(read!.metrics.candidateCount).toBe(6);
    expect(read!.refreshedAt).toBe('2026-10-06T13:00:00.000Z');
  });

  it('ignores malformed refresh payloads without throwing', () => {
    expect(() => eventBus.emit(PREMARKET_REFRESH_COMPLETED, null)).not.toThrow();
    expect(() => eventBus.emit(PREMARKET_REFRESH_COMPLETED, { tradingDate: 'not-a-date' })).not.toThrow();
    expect(() => eventBus.emit(PREMARKET_REFRESH_COMPLETED, { tradingDate: TRADING_DATE, refreshVersion: -1 })).not.toThrow();
  });
});
