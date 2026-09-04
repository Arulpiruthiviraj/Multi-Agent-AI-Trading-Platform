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

  it('real bug fix (2026-09-04 missed-opportunity forensic audit): logChiefConsensus() must not have its own terminal lifecycleStatus clobbered back to ANALYZING by the ChiefTraderAgent reasoning entry it logs immediately afterward', async () => {
    // Confirmed live against the running DB before this fix: every transaction_traces row for
    // today's QQQ/SPY consensus rounds read lifecycleStatus='ANALYZING' even though
    // terminalReason correctly recorded "[NO TRADE] Confidence X% did not clear 75%." - because
    // logChiefConsensus() used to log its own synthetic ChiefTraderAgent thought via the public
    // logAgentThought(), which unconditionally re-upserts lifecycleStatus='ANALYZING' for every
    // agent-reasoning write. That false 'ANALYZING' status then fed a real downstream bug in
    // MissedOpportunityDetector (a separate regression test covers that consumer directly).
    const { tracingService } = await import('../services/TracingService');
    const { db } = await import('../db');
    const { transactionTraces, agentReasoningLogs } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    tracingService.logChiefConsensus({
      traceId: 'trace_NOCONSENSUS_1700000000_dead',
      symbol: 'QQQ',
      approved: false,
      consensusScore: 0.251,
      consensusThreshold: 0.75,
      terminalReason: '[NO TRADE] Confidence 25.1% did not clear 75%.',
      votingMatrix: [
        { agent: 'KronosEngine', side: 'SELL', confidence: 0.472, weight: 1, agreed: false },
      ],
    });
    await tracingService.flush();

    const tx = await db.select().from(transactionTraces).where(eq(transactionTraces.traceId, 'trace_NOCONSENSUS_1700000000_dead')).get();
    expect(tx?.lifecycleStatus).toBe('NO_CONSENSUS');
    expect(tx?.terminalReason).toBe('[NO TRADE] Confidence 25.1% did not clear 75%.');

    // The ChiefTraderAgent reasoning entry must still be written - only the trace-status
    // clobbering is fixed, not the reasoning log itself.
    const chiefThought = await db.select().from(agentReasoningLogs)
      .where(eq(agentReasoningLogs.traceId, 'trace_NOCONSENSUS_1700000000_dead')).all();
    expect(chiefThought.some(r => r.agentName === 'ChiefTraderAgent' && r.action === 'VETO')).toBe(true);
  });

  it('real bug fix (2026-09-04 missed-opportunity forensic audit): an APPROVED consensus round keeps CONSENSUS_REACHED as its terminal status too', async () => {
    const { tracingService } = await import('../services/TracingService');
    const { db } = await import('../db');
    const { transactionTraces } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');

    tracingService.logChiefConsensus({
      traceId: 'trace_APPROVED_1700000000_beef',
      symbol: 'MRK',
      approved: true,
      consensusScore: 0.81,
      consensusThreshold: 0.75,
      terminalReason: 'Consensus reached: 0.81 >= 0.75',
      votingMatrix: [
        { agent: 'QuantEngine', side: 'BUY', confidence: 0.8, weight: 0.831, agreed: true },
        { agent: 'NewsAgent', side: 'BUY', confidence: 0.666, weight: 0.946, agreed: true },
      ],
    });
    await tracingService.flush();

    const tx = await db.select().from(transactionTraces).where(eq(transactionTraces.traceId, 'trace_APPROVED_1700000000_beef')).get();
    expect(tx?.lifecycleStatus).toBe('CONSENSUS_REACHED');
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
