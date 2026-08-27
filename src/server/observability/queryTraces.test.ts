import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('getDecisionTrace + observability persist', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus-obs-query-${Date.now()}-${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
  });

  afterEach(() => {
    delete process.env.ARGUS_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
  });

  it('assembles a decision from SQLite and hashes AI prompts instead of returning secrets', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { agentReasoningLogs, transactionTraces, observabilityEvents, aiCalls } = await import('../db/schema');
    const { getDecisionTrace } = await import('./queryTraces');
    const { hashSensitive } = await import('./hashSensitive');

    const traceId = 'trace_OBS_1700000000_cafe';
    await db.insert(transactionTraces).values({
      traceId,
      symbol: 'OBS',
      createdAt: new Date().toISOString(),
      lifecycleStatus: 'ANALYZING',
      contributingAgents: JSON.stringify(['TechnicalAgent']),
    });
    await db.insert(agentReasoningLogs).values({
      traceId,
      timestamp: new Date().toISOString(),
      agentName: 'TechnicalAgent',
      symbol: 'OBS',
      action: 'BUY',
      confidence: 0.8,
      reasoningSummary: 'unit',
    });
    await db.insert(observabilityEvents).values({
      id: 'evt-1',
      ts: Date.now(),
      level: 'INFO',
      category: 'AGENT',
      eventType: 'TRADE_IDEA_GENERATED',
      loggerName: 'EventBus',
      message: 'TRADE_IDEA_GENERATED',
      sessionId: 'sess_test',
      correlationId: traceId,
      decisionId: traceId,
      traceId,
      symbol: 'OBS',
      component: 'EventBus',
      payload: JSON.stringify({ apiKey: 'should-not-appear-in-export-raw' }),
    });
    await db.insert(aiCalls).values({
      id: 'ai-1',
      traceId,
      agent: 'ChiefTrader',
      provider: 'test',
      prompt: 'SECRET_PROMPT_VALUE_DO_NOT_ECHO',
      status: 'success',
      createdAt: new Date().toISOString(),
    });

    const assembled = await getDecisionTrace(traceId);
    expect(assembled.ok).toBe(true);
    expect(assembled.decisionId).toBe(traceId);
    expect(assembled.correlationId).toBe(traceId);
    expect(assembled.symbol).toBe('OBS');
    expect(assembled.agentThoughts.some((t: any) => t.agent === 'TechnicalAgent')).toBe(true);
    expect(assembled.aiCalls[0].promptHash).toBe(hashSensitive('SECRET_PROMPT_VALUE_DO_NOT_ECHO'));
    expect(JSON.stringify(assembled.aiCalls)).not.toContain('SECRET_PROMPT_VALUE_DO_NOT_ECHO');
  });

  it('computes a stage-by-stage latency breakdown from real event_traces rows, and reports MARKET_DATA honestly unavailable', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { eventTraces } = await import('../db/schema');
    const { getDecisionTrace } = await import('./queryTraces');

    const traceId = 'trace_LAT_1700000000_beef';
    const t0 = 1_700_000_000_000;
    const rows: Array<[string, number]> = [
      ['TRADE_IDEA_GENERATED', t0],
      ['CHIEF_CONSENSUS_STARTED', t0 + 10],
      ['CHIEF_CONSENSUS_COMPLETED', t0 + 45],
      ['RISK_ASSESSMENT_STARTED', t0 + 50],
      ['RISK_ASSESSMENT_COMPLETED', t0 + 90],
      ['ORDER_SUBMITTED', t0 + 95],
      ['ORDER_EXECUTED', t0 + 180],
    ];
    for (const [eventType, timestamp] of rows) {
      await db.insert(eventTraces).values({
        id: `evt-${eventType}`,
        correlationId: traceId,
        timestamp,
        source: 'unit-test',
        eventType,
        payload: '{}',
      });
    }

    const assembled = await getDecisionTrace(traceId);
    const breakdown = (assembled as any).latencyBreakdown;
    expect(breakdown.totalLatencyMs).toBe(180);
    expect(breakdown.firstStage).toBe('ideaGenerated');
    expect(breakdown.lastStage).toBe('orderExecuted');
    expect(breakdown.stages.ideaGeneratedToConsensusStartedMs).toBe(10);
    expect(breakdown.stages.consensusStartedToConsensusCompletedMs).toBe(35);
    expect(breakdown.stages.consensusCompletedToRiskStartedMs).toBe(5);
    expect(breakdown.stages.riskStartedToRiskCompletedMs).toBe(40);
    expect(breakdown.stages.riskCompletedToOrderSubmittedMs).toBe(5);
    expect(breakdown.stages.orderSubmittedToOrderExecutedMs).toBe(85);
    expect(breakdown.marketDataToSignalMs).toBeNull();
    expect(breakdown.marketDataToSignalUnavailableReason).toMatch(/not durably persisted/);
  });

  it('returns a null total when fewer than two milestone stages are present', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { eventTraces } = await import('../db/schema');
    const { getDecisionTrace } = await import('./queryTraces');

    const traceId = 'trace_LAT_1700000000_single';
    await db.insert(eventTraces).values({
      id: 'evt-only',
      correlationId: traceId,
      timestamp: Date.now(),
      source: 'unit-test',
      eventType: 'TRADE_IDEA_GENERATED',
      payload: '{}',
    });

    const assembled = await getDecisionTrace(traceId);
    const breakdown = (assembled as any).latencyBreakdown;
    expect(breakdown.totalLatencyMs).toBeNull();
    expect(Object.keys(breakdown.stages)).toHaveLength(0);
  });
});

describe('getFullDecisionFunnelTrace (Phase 4A Decision Funnel, 2026-08-26)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus-funnel-full-${Date.now()}-${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
  });

  afterEach(() => {
    delete process.env.ARGUS_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
  });

  it('prepends reconstructed pre-idea stages to the existing getDecisionTrace result, without altering it', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { eventTraces, transactionTraces } = await import('../db/schema');
    const { getFullDecisionFunnelTrace, getDecisionTrace } = await import('./queryTraces');

    const traceId = 'trace_FUNNEL_1800000000_dead';
    const ideaTs = 1_800_000_000_000;
    const scanTs = ideaTs - 5 * 60 * 1000;

    await db.insert(transactionTraces).values({
      traceId, symbol: 'FUNL', createdAt: new Date(ideaTs).toISOString(), lifecycleStatus: 'ANALYZING',
    });
    await db.insert(eventTraces).values({
      id: 'evt-scan-full', correlationId: null, timestamp: scanTs, source: 'OpportunityDiscovery',
      eventType: 'OPPORTUNITY_SCAN_COMPLETED',
      payload: JSON.stringify({ shortlist: [{ symbol: 'FUNL', assetClass: 'ETF', reason: 'already_subscribed' }] }),
    });
    await db.insert(eventTraces).values({
      id: 'evt-idea-full', correlationId: traceId, timestamp: ideaTs, source: 'TechnicalAgent',
      eventType: 'TRADE_IDEA_GENERATED', payload: JSON.stringify({ symbol: 'FUNL', agent: 'TechnicalAgent' }),
    });

    const plain = await getDecisionTrace(traceId);
    const full = await getFullDecisionFunnelTrace(traceId);

    // The wrapper must not change anything getDecisionTrace already reports.
    expect(full.timeline).toEqual(plain.timeline);
    expect(full.symbol).toBe('FUNL');

    const byStage = Object.fromEntries(full.preIdeaStages.map((s) => [s.stage, s]));
    expect(byStage.DISCOVERED.status).toBe('RECONSTRUCTED');
    expect(byStage.PROMOTED.status).toBe('RECONSTRUCTED');
    expect(byStage.DATA_READY.status).toBe('RECONSTRUCTED');
  });

  it('returns empty preIdeaStages (not an error) when the trace has no symbol at all', async () => {
    vi.resetModules();
    const { getFullDecisionFunnelTrace } = await import('./queryTraces');
    const full = await getFullDecisionFunnelTrace('trace_NONEXISTENT_0_0000');
    expect(full.ok).toBe(true);
    expect(full.preIdeaStages).toEqual([]);
  });
});
