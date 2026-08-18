import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('real bug fix (2026-08-18 observability program, Phase 15): the pending-write queue never grows past maxQueueSize during a sustained DB outage - a fire-and-forget forensic sink must not exhaust memory while trading keeps running', async () => {
    vi.useFakeTimers();
    try {
      const { tracingService } = await import('../services/TracingService');
      const { sqliteDb } = await import('../db');
      const { tracingConfig } = await import('../config/tracing');

      // Force every subsequent DB write to throw, simulating a sustained SQLite outage.
      sqliteDb.close();

      const totalToEnqueue = tracingConfig.maxQueueSize + tracingConfig.maxBatchSize * 3;
      for (let i = 0; i < totalToEnqueue; i++) {
        tracingService.logAgentThought({
          traceId: `trace_CAP_${i}`,
          agentName: 'TestAgent',
          symbol: 'CAP',
          action: 'HOLD',
          confidence: 0.5,
          reasoningSummary: 'backpressure test',
        });
      }

      // Drain enough fake-timer flush cycles for every failing batch to have been attempted and
      // re-queued at least once - each attempt is a rejected DB call, not a real timer wait, so a
      // handful of ticks is enough regardless of totalToEnqueue.
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(tracingConfig.batchFlushMs);
      }

      expect(tracingService.queueLengthForTests()).toBeLessThanOrEqual(tracingConfig.maxQueueSize);
      expect(tracingService.queueLengthForTests()).toBeGreaterThan(0); // DB is still down - not silently emptied
    } finally {
      vi.useRealTimers();
    }
  });
});
