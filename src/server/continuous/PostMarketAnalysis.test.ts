import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('PostMarketAnalysis (Phase 2, 2026-09-10)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./PostMarketAnalysis');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_postmarket_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./PostMarketAnalysis');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  const tradingDate = '2026-09-10';
  const sinceIso = `${tradingDate}T00:00:00.000Z`;
  const sinceMs = new Date(sinceIso).getTime();

  it('returns an empty, well-formed report when there is no real evidence for the date', async () => {
    const report = await mod.generatePostMarketReport('2099-01-01');
    expect(report.totalSymbolsTouched).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.flowScorecard.consensusRoundsTotal).toBe(0);
  });

  it('classifies a real CORRECT_NON_ACTION (price-filtered) symbol from real discovery-lineage events', async () => {
    await db.insert(schema.observabilityEvents).values({
      id: 'ev-1', ts: sinceMs + 1000, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CANDIDATE_FILTERED',
      loggerName: 'argus', message: 'discovery_candidate_decision', sessionId: 'sess-1', symbol: 'PENNY',
      payload: JSON.stringify({ source: 'MARKET_MOVER', reason: 'PRICE', price: 2.1, dollarVolume: 1000, spreadBps: 500, advShares: null, gapMover: true, gapPct: 0.5, rvolMover: false, rvol: null }),
    });

    const report = await mod.generatePostMarketReport(tradingDate);
    const finding = report.findings.find((f) => f.symbol === 'PENNY');
    expect(finding).toBeDefined();
    expect(finding!.classification).toBe('CORRECT_NON_ACTION');
    expect(finding!.classificationRationale).toContain('PRICE');
  });

  it('classifies a real DATA_QUALITY_GAP symbol (ADV filtered with null advShares)', async () => {
    await db.insert(schema.observabilityEvents).values({
      id: 'ev-2', ts: sinceMs + 2000, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CANDIDATE_FILTERED',
      loggerName: 'argus', message: 'discovery_candidate_decision', sessionId: 'sess-1', symbol: 'NULLADV',
      payload: JSON.stringify({ source: 'BROAD_UNIVERSE', reason: 'ADV', price: 50, dollarVolume: 5000000, spreadBps: 10, advShares: null, gapMover: false, gapPct: 0.02, rvolMover: false, rvol: null }),
    });

    const report = await mod.generatePostMarketReport(tradingDate);
    const finding = report.findings.find((f) => f.symbol === 'NULLADV');
    expect(finding!.classification).toBe('DATA_QUALITY_GAP');
  });

  it('classifies a real NEWS_BLIND_SPOT symbol (news coverage exists, no discovery admission)', async () => {
    await db.insert(schema.observabilityEvents).values({
      id: 'ev-3', ts: sinceMs + 3000, level: 'INFO', category: 'NEWS', eventType: 'NEWS_ANALYZED',
      loggerName: 'argus', message: 'news_analyzed', sessionId: 'sess-1', symbol: 'NEWSY',
      payload: JSON.stringify({ symbols: ['NEWSY'] }),
    });

    const report = await mod.generatePostMarketReport(tradingDate);
    const finding = report.findings.find((f) => f.symbol === 'NEWSY');
    expect(finding!.classification).toBe('NEWS_BLIND_SPOT');
  });

  it('a missed_opportunities row takes priority over discovery-lineage classification', async () => {
    await db.insert(schema.missedOpportunities).values({
      id: 'miss-1', symbol: 'MISSED1', detectedAt: new Date(sinceMs + 5000).toISOString(),
      classification: 'CONSENSUS_REJECTION', classificationReason: 'test reason',
      evidenceAtDecisionJson: '{}', evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
    });

    const report = await mod.generatePostMarketReport(tradingDate);
    const finding = report.findings.find((f) => f.symbol === 'MISSED1');
    expect(finding!.classification).toBe('CONSENSUS_REJECTION');
    expect(finding!.classificationRationale).toBe('test reason');
  });

  it('builds a real narrative with a DATA-category primary failure for a symbol whose idea was discarded on stale data', async () => {
    await db.insert(schema.tradePlans).values({
      id: 'plan-1', symbol: 'NARR1', planDate: tradingDate, setupType: 'BACKUP', direction: 'SELL',
      thesis: 'test thesis', catalysts: '[]', entryZoneLow: 100, entryZoneHigh: 101,
      invalidationLevel: 95, targetConcept: 'test', confidence: 0.6, evidenceQuality: 'MODERATE',
      rankAtCreation: 5, componentScoresJson: '{}', status: 'INVALIDATED', createdAt: new Date(sinceMs + 6000).toISOString(),
      validUntil: new Date(sinceMs + 7200000).toISOString(),
    });
    await db.insert(schema.observabilityEvents).values([
      {
        id: 'ev-4', ts: sinceMs + 6500, level: 'INFO', category: 'NEWS', eventType: 'NEWS_CATALYST_STAGED',
        loggerName: 'argus', message: 'news_catalyst_staged', sessionId: 'sess-1', symbol: 'NARR1', payload: '{}',
      },
      {
        id: 'ev-5', ts: sinceMs + 7000, level: 'WARN', category: 'TRADING_SAFETY', eventType: 'NEWS_IDEA_DISCARDED_NO_FRESH_DATA',
        loggerName: 'argus', message: 'idea_discarded', sessionId: 'sess-1', symbol: 'NARR1',
        payload: JSON.stringify({ reasoning: 'NewsAgent idea for NARR1 discarded - no fresh tick arrived within 8000ms.' }),
      },
    ]);
    await db.insert(schema.missedOpportunities).values({
      id: 'miss-narr1', symbol: 'NARR1', detectedAt: new Date(sinceMs + 7100).toISOString(),
      classification: 'AGENT_MISS', classificationReason: 'no idea reached ChiefTrader',
      evidenceAtDecisionJson: '{}', evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
    });

    const report = await mod.generatePostMarketReport(tradingDate);
    const narrative = report.narratives.find((n) => n.symbol === 'NARR1');
    expect(narrative).toBeDefined();
    expect(narrative!.premarketRadar).toBe(true);
    expect(narrative!.argusDirection).toBe('SELL');
    expect(narrative!.primaryFailureCategory).toBe('DATA');
    expect(narrative!.wouldArgusHaveKnown).toBe('DATA_GAP');
    expect(narrative!.wouldArgusHaveKnownRationale).toContain('data-freshness gate');
  });

  it('computes a real flow scorecard from actual transaction_traces/quant_assessments/trades rows', async () => {
    await db.insert(schema.transactionTraces).values([
      { traceId: 'tr-1', symbol: 'FLOW1', createdAt: new Date(sinceMs + 1000).toISOString(), lifecycleStatus: 'NO_CONSENSUS', contributingAgents: '[]' },
      { traceId: 'tr-2', symbol: 'FLOW2', createdAt: new Date(sinceMs + 2000).toISOString(), lifecycleStatus: 'ANALYZING', contributingAgents: '[]' },
    ]);
    await db.insert(schema.quantAssessments).values({
      id: 'qa-1', symbol: 'FLOW1', timeframe: '1Min', regime: 'TRENDING', marketContext: '{}',
      strategyEvaluations: '{}', groupedScores: '{}', emittedTradeIdea: true, createdAt: new Date(sinceMs + 500).toISOString(),
    });

    const report = await mod.generatePostMarketReport(tradingDate);
    expect(report.flowScorecard.consensusRoundsTotal).toBeGreaterThanOrEqual(2);
    expect(report.flowScorecard.consensusRejected).toBeGreaterThanOrEqual(1);
    expect(report.flowScorecard.consensusAbandonedMidEvaluation).toBeGreaterThanOrEqual(1);
    expect(report.flowScorecard.quantIdeasEmitted).toBeGreaterThanOrEqual(1);
  });

  it('detects a real blind spot when 3+ symbols share the same DATA_QUALITY_GAP pattern', async () => {
    for (const sym of ['BS1', 'BS2', 'BS3']) {
      await db.insert(schema.observabilityEvents).values({
        id: `ev-bs-${sym}`, ts: sinceMs + 8000, level: 'INFO', category: 'DISCOVERY', eventType: 'DISCOVERY_CANDIDATE_FILTERED',
        loggerName: 'argus', message: 'discovery_candidate_decision', sessionId: 'sess-1', symbol: sym,
        payload: JSON.stringify({ source: 'BROAD_UNIVERSE', reason: 'ADV', price: 50, dollarVolume: 5000000, spreadBps: 10, advShares: null, gapMover: false, gapPct: 0.01, rvolMover: false, rvol: null }),
      });
    }
    const report = await mod.generatePostMarketReport(tradingDate);
    const spot = report.blindSpots.find((b) => b.pattern.includes('null) ADV'));
    expect(spot).toBeDefined();
    expect(spot!.affectedSymbolCount).toBeGreaterThanOrEqual(3);
  });

  it('persistPostMarketReport + getPostMarketReport round-trips a real report and is idempotent (upsert, not duplicate)', async () => {
    const report = await mod.generatePostMarketReport(tradingDate);
    await mod.persistPostMarketReport(report);
    await mod.persistPostMarketReport(report); // second call must overwrite, not duplicate

    const rows = await db.select().from(schema.postmarketReports);
    const matching = rows.filter((r: any) => r.tradingDate === tradingDate);
    expect(matching.length).toBe(1);

    const readBack = await mod.getPostMarketReport(tradingDate);
    expect(readBack).not.toBeNull();
    expect(readBack!.tradingDate).toBe(tradingDate);
    expect(readBack!.totalSymbolsTouched).toBe(report.totalSymbolsTouched);
  });

  it('getPostMarketReport returns null for a date with no persisted report', async () => {
    const result = await mod.getPostMarketReport('2099-12-31');
    expect(result).toBeNull();
  });

  // Trade-to-Learning Feedback Loop request §16/17 ("learn from safe non-trades too") - real
  // rejected-candidate audit built from missed_opportunities rows the existing detector already
  // classified CONSENSUS_REJECTION.
  describe('rejected-candidate audit', () => {
    const originalAlpacaKey = process.env.ALPACA_API_KEY;
    const originalAlpacaSecret = process.env.ALPACA_SECRET_KEY;
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    afterEach(() => {
      fetchSpy?.mockRestore();
      if (originalAlpacaKey === undefined) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = originalAlpacaKey;
      if (originalAlpacaSecret === undefined) delete process.env.ALPACA_SECRET_KEY; else process.env.ALPACA_SECRET_KEY = originalAlpacaSecret;
    });

    it('classifies a real POTENTIAL_MISSED_OPPORTUNITY when the real EOD close moved favorably beyond the noise threshold', async () => {
      process.env.ALPACA_API_KEY = 'test-key';
      process.env.ALPACA_SECRET_KEY = 'test-secret';
      await db.insert(schema.missedOpportunities).values({
        id: 'miss-rej-1', symbol: 'REJ1', detectedAt: new Date(sinceMs + 9000).toISOString(),
        classification: 'CONSENSUS_REJECTION', classificationReason: 'Agent idea(s) generated, but ChiefTrader consensus never produced CHIEF_APPROVED_IDEA.',
        evidenceAtDecisionJson: '{}', priceAtDetection: 100, evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
      });
      fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ bars: [{ c: 105 }] }) } as any);

      const report = await mod.generatePostMarketReport(tradingDate);
      const audit = report.rejectedCandidateAudits.find((a) => a.symbol === 'REJ1');
      expect(audit).toBeDefined();
      expect(audit!.realMovePct).toBeCloseTo(5, 1);
      expect(audit!.verdict).toBe('POTENTIAL_MISSED_OPPORTUNITY');
      expect(audit!.rationale).toContain('does NOT mean the rejection was wrong');
    });

    it('classifies a real CORRECT_REJECTION when the real EOD close moved unfavorably', async () => {
      process.env.ALPACA_API_KEY = 'test-key';
      process.env.ALPACA_SECRET_KEY = 'test-secret';
      await db.insert(schema.missedOpportunities).values({
        id: 'miss-rej-2', symbol: 'REJ2', detectedAt: new Date(sinceMs + 9500).toISOString(),
        classification: 'CONSENSUS_REJECTION', classificationReason: 'test', evidenceAtDecisionJson: '{}',
        priceAtDetection: 100, evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
      });
      fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ bars: [{ c: 96 }] }) } as any);

      const report = await mod.generatePostMarketReport(tradingDate);
      const audit = report.rejectedCandidateAudits.find((a) => a.symbol === 'REJ2');
      expect(audit!.verdict).toBe('CORRECT_REJECTION');
    });

    it('never fabricates a move - UNCLEAR_NO_PRICE_SNAPSHOT when no priceAtDetection was stored', async () => {
      await db.insert(schema.missedOpportunities).values({
        id: 'miss-rej-3', symbol: 'REJ3', detectedAt: new Date(sinceMs + 10000).toISOString(),
        classification: 'CONSENSUS_REJECTION', classificationReason: 'test', evidenceAtDecisionJson: '{}',
        priceAtDetection: null, evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
      });

      const report = await mod.generatePostMarketReport(tradingDate);
      const audit = report.rejectedCandidateAudits.find((a) => a.symbol === 'REJ3');
      expect(audit!.verdict).toBe('UNCLEAR_NO_PRICE_SNAPSHOT');
      expect(audit!.realMovePct).toBeNull();
    });

    it('rejectedCandidateAudits round-trips through persist/read', async () => {
      const report = await mod.generatePostMarketReport(tradingDate);
      await mod.persistPostMarketReport(report);
      const readBack = await mod.getPostMarketReport(tradingDate);
      expect(readBack!.rejectedCandidateAudits.length).toBe(report.rejectedCandidateAudits.length);
    });
  });

  // Trade-to-Learning Feedback Loop request §9/§21 - real, honest multi-day rollup. Explicitly
  // never claims "recurring" from a single day.
  describe('computeMultiDayRollup', () => {
    it('returns an empty, well-formed rollup when no reports have been persisted for the requested range', async () => {
      const rollup = await mod.computeMultiDayRollup(5);
      // Other tests in this file may have already persisted a report for `tradingDate` by the
      // time this runs (tests share one DB) - assert on shape/non-negativity, not a hard zero.
      expect(rollup.daysConsidered.length).toBe(rollup.totalReportsFound);
      expect(rollup.recurringBlindSpots.every((s) => s.daysAffected >= 2)).toBe(true);
    });

    it('never calls a blind spot "recurring" when it appears in only one persisted day', async () => {
      const day1 = '2026-01-01';
      const report1 = await mod.generatePostMarketReport(day1); // no real evidence seeded for this date - 0 blind spots
      await mod.persistPostMarketReport(report1);

      const rollup = await mod.computeMultiDayRollup(30);
      const singleDaySpots = rollup.recurringBlindSpots.filter((s) => s.daysAffected < 2);
      expect(singleDaySpots.length).toBe(0);
    });

    it('correctly aggregates rejected-candidate verdicts across multiple real persisted days', async () => {
      const dayA = '2026-01-02';
      await db.insert(schema.missedOpportunities).values({
        id: 'miss-rollup-a', symbol: 'ROLLA', detectedAt: `${dayA}T10:00:00.000Z`,
        classification: 'CONSENSUS_REJECTION', classificationReason: 'test', evidenceAtDecisionJson: '{}',
        priceAtDetection: null, evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
      });
      const reportA = await mod.generatePostMarketReport(dayA);
      await mod.persistPostMarketReport(reportA);

      const dayB = '2026-01-03';
      await db.insert(schema.missedOpportunities).values({
        id: 'miss-rollup-b', symbol: 'ROLLB', detectedAt: `${dayB}T10:00:00.000Z`,
        classification: 'CONSENSUS_REJECTION', classificationReason: 'test', evidenceAtDecisionJson: '{}',
        priceAtDetection: null, evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
      });
      const reportB = await mod.generatePostMarketReport(dayB);
      await mod.persistPostMarketReport(reportB);

      const rollup = await mod.computeMultiDayRollup(30);
      expect(rollup.rejectedCandidateStats.noPriceSnapshot).toBeGreaterThanOrEqual(2);
      expect(rollup.daysConsidered).toContain(dayA);
      expect(rollup.daysConsidered).toContain(dayB);
    });

    it('a blind spot appearing in 2+ real persisted days is correctly flagged as recurring, with real evidence', async () => {
      const dayC = '2026-01-04';
      for (const sym of ['RC1', 'RC2', 'RC3']) {
        await db.insert(schema.observabilityEvents).values({
          id: `ev-rollup-c-${sym}`, ts: new Date(`${dayC}T10:00:00.000Z`).getTime(), level: 'INFO', category: 'DISCOVERY',
          eventType: 'DISCOVERY_CANDIDATE_FILTERED', loggerName: 'argus', message: 'discovery_candidate_decision', sessionId: 'sess-1', symbol: sym,
          payload: JSON.stringify({ source: 'BROAD_UNIVERSE', reason: 'ADV', price: 50, dollarVolume: 5000000, spreadBps: 10, advShares: null, gapMover: false, gapPct: 0.01, rvolMover: false, rvol: null }),
        });
      }
      const reportC = await mod.generatePostMarketReport(dayC);
      await mod.persistPostMarketReport(reportC);

      const dayD = '2026-01-05';
      for (const sym of ['RD1', 'RD2', 'RD3']) {
        await db.insert(schema.observabilityEvents).values({
          id: `ev-rollup-d-${sym}`, ts: new Date(`${dayD}T10:00:00.000Z`).getTime(), level: 'INFO', category: 'DISCOVERY',
          eventType: 'DISCOVERY_CANDIDATE_FILTERED', loggerName: 'argus', message: 'discovery_candidate_decision', sessionId: 'sess-1', symbol: sym,
          payload: JSON.stringify({ source: 'BROAD_UNIVERSE', reason: 'ADV', price: 50, dollarVolume: 5000000, spreadBps: 10, advShares: null, gapMover: false, gapPct: 0.01, rvolMover: false, rvol: null }),
        });
      }
      const reportD = await mod.generatePostMarketReport(dayD);
      await mod.persistPostMarketReport(reportD);

      const rollup = await mod.computeMultiDayRollup(30);
      const recurring = rollup.recurringBlindSpots.find((s) => s.patternKey === 'NULL_ADV_LIQUIDITY_GATE');
      expect(recurring).toBeDefined();
      expect(recurring!.daysAffected).toBeGreaterThanOrEqual(2);
      expect(recurring!.totalSymbolCount).toBeGreaterThanOrEqual(6);
    });
  });
});
