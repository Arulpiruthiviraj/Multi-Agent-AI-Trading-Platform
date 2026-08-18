import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('TracingService persistence', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus-trace-test-${Date.now()}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
  });

  afterEach(() => {
    delete process.env.ARGUS_DB_PATH;
    try {
      if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
      if (fs.existsSync(`${tmpDbPath}-wal`)) fs.unlinkSync(`${tmpDbPath}-wal`);
    } catch {
      // ignore cleanup errors on Windows file locks
    }
  });

  it('persists agent reasoning and transaction trace rows', async () => {
    const { tracingService } = await import('../services/TracingService');
    const { db } = await import('../db');
    const { agentReasoningLogs, transactionTraces } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    tracingService.logAgentThought({
      traceId: 'trace_UNIT_1700000000_cafe',
      agentName: 'TechnicalAgent',
      symbol: 'UNIT',
      action: 'BUY',
      confidence: 0.82,
      reasoningSummary: 'RSI(14)=28.4 oversold -> BUY',
      indicatorsSnapshot: { rsi: 28.4 },
      executionLatencyMs: 12,
    });
    await tracingService.flush();

    const thought = await db.select().from(agentReasoningLogs).where(eq(agentReasoningLogs.traceId, 'trace_UNIT_1700000000_cafe')).get();
    expect(thought?.agentName).toBe('TechnicalAgent');
    expect(thought?.confidence).toBe(0.82);

    const tx = await db.select().from(transactionTraces).where(eq(transactionTraces.traceId, 'trace_UNIT_1700000000_cafe')).get();
    expect(tx?.symbol).toBe('UNIT');
    expect(tx?.lifecycleStatus).toBe('ANALYZING');
  });
});
