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
});
