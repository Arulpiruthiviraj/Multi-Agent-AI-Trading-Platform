import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('agentEdgeAnalytics', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./agentEdgeAnalytics');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_agent_edge_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./agentEdgeAnalytics');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seedGraded(agent: string, symbol: string, side: 'BUY' | 'SELL', confidence: number, ts: number, outcome: 'WIN' | 'LOSS', idSuffix: string, reasoning: string = 'test reasoning') {
    const id = `pred-${agent}-${idSuffix}`;
    return Promise.all([
      db.insert(schema.agentPredictions).values({
        id, agentName: agent, symbol, prediction: side, confidence, reasoning,
        timestamp: new Date(ts).toISOString(),
      }),
      db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol,
        actualPrice: 101, actualReturn: 0.01, actualDirection: side === 'BUY' ? 'UP' : 'DOWN',
        mfe: 0.01, mae: 0, outcome, evaluatedAt: new Date(ts).toISOString(),
      }),
    ]);
  }

  it('returns an empty report when no predictions exist', async () => {
    const rows = await mod.buildAgentEdgeReport();
    expect(rows).toEqual([]);
  });

  it('classifies a statistically significant WINNING agent as ABOVE_CHANCE / EDGE_SUPPORTED', async () => {
    const base = new Date('2026-08-01T09:00:00.000Z').getTime();
    for (let i = 0; i < 30; i++) {
      await seedGraded('WinnerAgent', 'WIN', 'BUY', 0.7, base + i * 2 * 60 * 60000, i < 25 ? 'WIN' : 'LOSS', `w${i}`);
    }
    const rows = await mod.buildAgentEdgeReport();
    const row = rows.find((r) => r.agentName === 'WinnerAgent' && r.strategyId === null)!;
    expect(row.statisticalStatus).toBe('ABOVE_CHANCE');
    expect(row.sampleMaturity).toBe('LEARNING_ELIGIBLE');
    expect(row.evidenceClassification).toBe('EDGE_SUPPORTED');
    expect(row.wilsonLower).toBeGreaterThan(0.5);
    expect(row.brierScore).not.toBeNull();
    expect(row.brierScore!).toBeLessThan(0.25); // better than the always-guess-50% baseline
  });

  it('classifies a statistically INSIGNIFICANT (chance-level) agent with enough N as neither ABOVE nor BELOW chance - NO_EDGE, not INSUFFICIENT_EVIDENCE', async () => {
    const base = new Date('2026-08-02T09:00:00.000Z').getTime();
    for (let i = 0; i < 30; i++) {
      await seedGraded('ChanceAgentEdge', 'CHN', 'BUY', 0.65, base + i * 2 * 60 * 60000, i % 2 === 0 ? 'WIN' : 'LOSS', `c${i}`);
    }
    const rows = await mod.buildAgentEdgeReport();
    const row = rows.find((r) => r.agentName === 'ChanceAgentEdge' && r.strategyId === null)!;
    expect(row.sampleMaturity).toBe('LEARNING_ELIGIBLE');
    expect(row.statisticalStatus).toBe('NO_EDGE_DETECTABLE');
    // The whole point of this derived field: enough real evidence exists here (unlike the thin-N
    // case below), so this must read as a real, tested "no edge" - never conflated with "not
    // enough data yet", which would be a different, weaker claim.
    expect(row.evidenceClassification).toBe('NO_EDGE');
  });

  it('classifies an agent below the sample-size floor as NO_EDGE_DETECTABLE with INSUFFICIENT_EVIDENCE maturity, regardless of its raw win rate - and NEVER as EDGE_SUPPORTED no matter how high the raw win rate looks', async () => {
    const base = new Date('2026-08-03T09:00:00.000Z').getTime();
    for (let i = 0; i < 5; i++) {
      await seedGraded('ThinAgentEdge', 'THN', 'BUY', 0.7, base + i * 2 * 60 * 60000, 'WIN', `t${i}`);
    }
    const rows = await mod.buildAgentEdgeReport();
    const row = rows.find((r) => r.agentName === 'ThinAgentEdge' && r.strategyId === null)!;
    expect(row.sampleMaturity).toBe('INSUFFICIENT_EVIDENCE');
    expect(row.statisticalStatus).toBe('NO_EDGE_DETECTABLE');
    // 5/5 WINs (100% raw win rate) must NOT read as EDGE_SUPPORTED - this is exactly the
    // "do not let a small n become a promotion signal" case the mission named.
    expect(row.evidenceClassification).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('classifies a statistically significant LOSING agent as BELOW_CHANCE / EDGE_DISPROVEN, distinct from NO_EDGE', async () => {
    const base = new Date('2026-08-05T09:00:00.000Z').getTime();
    for (let i = 0; i < 30; i++) {
      await seedGraded('LoserAgentEdge', 'LSR', 'BUY', 0.7, base + i * 2 * 60 * 60000, i < 25 ? 'LOSS' : 'WIN', `l${i}`);
    }
    const rows = await mod.buildAgentEdgeReport();
    const row = rows.find((r) => r.agentName === 'LoserAgentEdge' && r.strategyId === null)!;
    expect(row.statisticalStatus).toBe('BELOW_CHANCE');
    expect(row.evidenceClassification).toBe('EDGE_DISPROVEN');
  });

  it('produces a separate row per real QuantEngine strategy id (secondaryGroupKey), not just one overall row', async () => {
    const base = new Date('2026-08-04T09:00:00.000Z').getTime();
    for (let i = 0; i < 10; i++) {
      await seedGraded('QuantEngine', 'QNT', 'BUY', 0.85, base + i * 2 * 60 * 60000, 'WIN', `q1-${i}`, 'QuantEngine/MOMENTUM_BREAKOUT: real reasoning');
    }
    for (let i = 0; i < 10; i++) {
      await seedGraded('QuantEngine', 'QNT2', 'BUY', 0.85, base + 100 * 60 * 60000 + i * 2 * 60 * 60000, 'LOSS', `q2-${i}`, 'QuantEngine/MEAN_REVERSION: real reasoning');
    }
    const rows = await mod.buildAgentEdgeReport();
    const momentum = rows.find((r) => r.agentName === 'QuantEngine' && r.strategyId === 'MOMENTUM_BREAKOUT');
    const meanRev = rows.find((r) => r.agentName === 'QuantEngine' && r.strategyId === 'MEAN_REVERSION');
    expect(momentum).toBeDefined();
    expect(meanRev).toBeDefined();
    expect(momentum!.rawN).toBe(10);
    expect(meanRev!.rawN).toBe(10);
  });

  it('formatAgentEdgeReport renders a readable text table', async () => {
    const rows = await mod.buildAgentEdgeReport();
    const text = mod.formatAgentEdgeReport(rows);
    expect(text).toContain('AGENT EDGE');
    expect(text).toContain('WinnerAgent');
  });

  it('formatAgentEdgeReport never overflows a column, even for a long combined strategy id like "<STRATEGY>__COLD_START_BOOTSTRAP" - real bug fixed twice with fixed widths, now derives width from the longest actual value', () => {
    const longRows: import('./agentEdgeAnalytics').AgentEdgeRow[] = [{
      agentName: 'QuantEngine', strategyId: 'PULLBACK_CONTINUATION__COLD_START_BOOTSTRAP',
      rawN: 494, effectiveN: 22, winRate: 0.227, wilsonLower: 0.101, wilsonUpper: 0.4,
      brierScore: 0.362, buyRate: 1, sellRate: 0, holdRate: 0, abstentionRate: 0,
      sampleMaturity: 'LEARNING_ELIGIBLE', statisticalStatus: 'BELOW_CHANCE', excludedFromWeightLearning: false,
      evidenceClassification: 'EDGE_DISPROVEN',
    }];
    const text = mod.formatAgentEdgeReport(longRows);
    const dataLine = text.split('\n').find((l) => l.includes('PULLBACK_CONTINUATION'))!;
    // The long strategy id must not run directly into the "494" N value with no separating space.
    expect(dataLine).not.toMatch(/BOOTSTRAP494/);
  });
});
