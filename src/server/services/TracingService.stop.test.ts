import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EVENTS } from '../core/eventNames';

/**
 * 2026-10-12 (L6): TracingService ran a batch-flush timer that was never cleared, and its
 * four event-bus handlers had no direct registration coverage. These tests prove (a) all four
 * handlers are registered and invoked on their events, and (b) stop() clears the batch-flush
 * timer AND performs a final flush of pending batches (the shutdown-drain contract).
 */
describe('TracingService registerEventListeners + stop() (L6)', () => {
  let tmpDbPath: string;
  let tracingService: any;
  let eventBus: any;
  let db: any;
  let schema: any;
  let eq: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus-trace-stop-${Date.now()}-${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ tracingService } = await import('./TracingService'));
    ({ eventBus } = await import('../core/EventBus'));
    ({ db } = await import('../db'));
    schema = await import('../db/schema');
    ({ eq } = await import('drizzle-orm'));
  });

  afterAll(() => {
    delete process.env.ARGUS_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
  });

  it('all four event handlers are registered and invoked on their events', async () => {
    const queuedBefore = tracingService.queueLengthForTests();

    // emitTradeIdea() is the canonical path real agents use (it runs the trade-idea gate).
    eventBus.emitTradeIdea({
      traceId: 'trace_STOP_idea', agent: 'TechnicalAgent', symbol: 'UNIT',
      side: 'BUY', confidence: 0.8, reasoning: 'listener registration test', latencyMs: 5,
      currentPrice: 100,
    });
    eventBus.emit(EVENTS.RISK_ASSESSMENT_COMPLETED, {
      traceId: 'trace_STOP_risk', symbol: 'UNIT', approved: true,
    });
    eventBus.emit(EVENTS.ORDER_SUBMITTED, {
      traceId: 'trace_STOP_sub', symbol: 'UNIT', orderId: 'ord-1', id: 'ord-1',
    });
    eventBus.emit(EVENTS.ORDER_EXECUTED, {
      traceId: 'trace_STOP_exec', symbol: 'UNIT', orderId: 'ord-2', id: 'ord-2', status: 'FILLED',
    });

    // The idea/submitted/executed handlers write synchronously on emit; the risk handler is
    // fire-and-forget (void updateRiskSummary) so its writes land a moment later.
    expect(tracingService.queueLengthForTests()).toBeGreaterThan(queuedBefore);
    await new Promise((r) => setTimeout(r, 25));
    await tracingService.flush();

    const thought = await db.select().from(schema.agentReasoningLogs)
      .where(eq(schema.agentReasoningLogs.traceId, 'trace_STOP_idea')).get();
    expect(thought?.agentName).toBe('TechnicalAgent');
    expect(thought?.action).toBe('BUY');

    const riskTrace = await db.select().from(schema.transactionTraces)
      .where(eq(schema.transactionTraces.traceId, 'trace_STOP_risk')).get();
    // The handler ran: risk summary persisted and the RiskAgent reasoning entry logged.
    // NOTE (observed, not asserted): lifecycleStatus reads 'ANALYZING', not 'RISK_APPROVED' -
    // updateRiskSummary() upserts the terminal status and then calls the public
    // logAgentThought(), whose ensureTraceRow(..., 'ANALYZING', ...) merges over it. This is
    // the same clobbering pattern logChiefConsensus() was fixed for on 2026-09-04 (see
    // logAgentReasoningRow's docstring) - reported to the parent as a suspected missed
    // instance; the status assertion below deliberately checks handler invocation only.
    expect(riskTrace?.riskSummary).toContain('"approved":true');
    const riskThought = await db.select().from(schema.agentReasoningLogs)
      .where(eq(schema.agentReasoningLogs.traceId, 'trace_STOP_risk')).get();
    expect(riskThought?.agentName).toBe('RiskAgent');

    const subTrace = await db.select().from(schema.transactionTraces)
      .where(eq(schema.transactionTraces.traceId, 'trace_STOP_sub')).get();
    expect(subTrace?.lifecycleStatus).toBe('ORDER_SUBMITTED');

    const execTrace = await db.select().from(schema.transactionTraces)
      .where(eq(schema.transactionTraces.traceId, 'trace_STOP_exec')).get();
    expect(execTrace?.lifecycleStatus).toBe('FILLED');
  });

  it('stop() clears the batch-flush timer and performs a final flush of pending batches', async () => {
    vi.useFakeTimers();
    try {
      const baselineTimers = vi.getTimerCount();
      tracingService.logAgentThought({
        traceId: 'trace_STOP_pending', agentName: 'TechnicalAgent', symbol: 'UNIT',
        action: 'HOLD', confidence: 0.5, reasoningSummary: 'pending flush test',
      });
      expect(tracingService.queueLengthForTests()).toBeGreaterThan(0);
      expect(vi.getTimerCount()).toBe(baselineTimers + 1); // batch-flush timer armed

      await tracingService.stop();

      expect(tracingService.queueLengthForTests()).toBe(0); // final flush persisted everything
      expect(vi.getTimerCount()).toBe(baselineTimers); // timer cleared, none re-armed

      const thought = await db.select().from(schema.agentReasoningLogs)
        .where(eq(schema.agentReasoningLogs.traceId, 'trace_STOP_pending')).get();
      expect(thought?.agentName).toBe('TechnicalAgent');

      // Advancing well past batchFlushMs must not trigger another flush cycle: with the
      // queue empty there is nothing to flush, and no dangling timer may re-arm one.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(tracingService.queueLengthForTests()).toBe(0);
      expect(vi.getTimerCount()).toBe(baselineTimers);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() is safe on an empty queue', async () => {
    await tracingService.flush();
    expect(tracingService.queueLengthForTests()).toBe(0);
    await expect(tracingService.stop()).resolves.toBeUndefined();
  });
});
