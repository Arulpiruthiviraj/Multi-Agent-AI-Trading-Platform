import { describe, it, expect, vi, beforeEach } from 'vitest';
import { performance } from 'node:perf_hooks';

/**
 * 2026-10-12 — pre-market perfection mission (item 1) regression tests: event-loop stall
 * mitigation. Defect-escape registry entry `event-loop-stall-20261012` (P0): on 2026-10-12
 * ~13:32-13:35 ET the production engine froze ~3 minutes (event-loop stall, /health timeouts,
 * CPU ~10%, self-recovered, cause UNKNOWN); nothing watched the loop continuously, nothing
 * persisted a stall record, nothing alerted.
 *
 * Fixture classification: SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY.
 * Every timing in this file is synthetic and injected in-process; nothing here touches the
 * live trading path, a real provider, or real market data. The per-file isolated temp SQLite
 * DB comes from vitest.setup.ts (the same isolation every real-DB test uses) - structuredLogger
 * writes land there, never in data/argus.db.
 *
 * What is covered:
 *  (a) the loop-lag monitor fires (EVENT_LOOP_LAG_WARN / STALL_DETECTED + the alerting hook)
 *      when the event loop is synthetically blocked, with thresholds taken from
 *      config/observability.json (no TS literals);
 *  (b) sync-persist timing warns (SYNC_PERSIST_SLOW) on an injected slow persist, and the
 *      instrumentation never changes the wrapped call's return value or throw semantics;
 *  (c) a superseded Quant evaluation cancels cooperatively: it throws before later stages
 *      execute (post-replacement resource use is bounded at zero further stages), emits only
 *      QUANT_EVAL_CANCELLED_SUPERSEDED, and the thrown error is the exact class that
 *      QuantSignalAgent.evaluateSymbol's catch maps to the non-emitting SUPERSEDED_CANCELLED
 *      path (null return = the established "no evaluation" return; no QUANT_ASSESSMENT_COMPLETED
 *      event, no quant_assessments row). The 486d51f generation-token isLiveCheck fence at
 *      emission remains the outer guarantee; this test covers the inner cancellation.
 */
const { triggerWebhooks } = vi.hoisted(() => ({
  triggerWebhooks: vi.fn(async (_evt: { type: string; message: string; details?: Record<string, unknown> }) => {}),
}));
vi.mock('../routes/webhooks', () => ({ triggerWebhooks }));

import {
  startEventLoopLagMonitor,
  stopEventLoopLagMonitor,
  getEventLoopLagStatus,
  getEventLoopLagSettings,
  setEventLoopLagSettingsForTests,
  resetEventLoopLagSettingsForTests,
  resetEventLoopLagMonitorForTests,
} from './eventLoopLagMonitor';
import { checkSyncPersistDuration, timeSyncPersist, timeAsyncPersist } from './syncPersistTiming';
import { structuredLogger } from './StructuredLogger';
import { observabilityConfig } from '../config/observability';
import { AlertingService, alertingService } from '../services/AlertingService';
import { throwIfSuperseded, QuantEvalSupersededError } from '../services/QuantSignalAgent';

/** Synthetic main-thread block (SYNTHETIC_SEEDED): burns exactly the loop for ms. */
function blockLoopSync(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* intentional busy-wait - this IS the synthetic stall under test */
  }
}

beforeEach(() => {
  triggerWebhooks.mockClear();
  resetEventLoopLagMonitorForTests();
  resetEventLoopLagSettingsForTests();
});

describe('event-loop lag monitor (item 1a)', () => {
  it('derives every threshold from config/observability.json - no TS literals', () => {
    const s = getEventLoopLagSettings();
    expect(s.sampleIntervalMs).toBe(observabilityConfig.eventLoopLagSampleIntervalMs);
    expect(s.warnMs).toBe(observabilityConfig.eventLoopLagWarnMs);
    expect(s.criticalMs).toBe(observabilityConfig.eventLoopLagCriticalMs);
    expect(s.cooldownMs).toBe(observabilityConfig.eventLoopLagAlertCooldownMs);
    // Sanity on the shipped values: warn is degraded-but-recovered, critical sits well under
    // the observed ~180s incident and far above healthy single-digit-ms 1s-tick drift.
    expect(s.warnMs).toBeLessThan(s.criticalMs);
    expect(s.criticalMs).toBeLessThan(180_000);
  });

  it('fires STALL_DETECTED + the alerting hook when the loop is synthetically blocked', async () => {
    setEventLoopLagSettingsForTests({
      sampleIntervalMs: 50,
      warnMs: 30,
      criticalMs: 100,
      cooldownMs: 0,
    });
    const errSpy = vi.spyOn(structuredLogger, 'error').mockImplementation(() => {});
    const alertSpy = vi.spyOn(alertingService, 'alertEventLoopStall').mockImplementation(() => {});
    startEventLoopLagMonitor();
    try {
      blockLoopSync(300); // synthetic ~300ms stall, comfortably above the 100ms critical line
      // Let the monitor's own (unref'd) timer fire now the loop is unblocked. An in-process
      // monitor can only ever observe a stall AFTER the loop unblocks - the measured lag then
      // approximates the stall duration, which is exactly the forensic quantity Oct-12 lacked.
      await new Promise((r) => setTimeout(r, 250));

      const status = getEventLoopLagStatus();
      expect(status.running).toBe(true);
      expect(status.stallCount).toBeGreaterThanOrEqual(1);
      expect(status.maxLagObservedMs).toBeGreaterThanOrEqual(100);

      const stallCalls = errSpy.mock.calls.filter((c) => c[1]?.eventType === 'STALL_DETECTED');
      expect(stallCalls.length).toBeGreaterThanOrEqual(1);
      const payload = stallCalls[0][1] as Record<string, unknown>;
      expect(payload.lagMs as number).toBeGreaterThanOrEqual(100);
      // Persisted forensic payload carries the quantities the Oct-12 incident was missing.
      expect(payload).toMatchObject({ sampleIntervalMs: 50, criticalMs: 100 });
      expect(payload.stallCount as number).toBeGreaterThanOrEqual(1);
      expect(typeof payload.uptimeSec).toBe('number');

      expect(alertSpy).toHaveBeenCalled();
      const alertPayload = alertSpy.mock.calls[0][0];
      expect(alertPayload.lagMs).toBeGreaterThanOrEqual(100);
      expect(alertPayload.stallCount).toBeGreaterThanOrEqual(1);
      expect(alertPayload.criticalMs).toBe(100);
    } finally {
      stopEventLoopLagMonitor();
      errSpy.mockRestore();
      alertSpy.mockRestore();
      resetEventLoopLagMonitorForTests();
      resetEventLoopLagSettingsForTests();
    }
  });

  it('fires EVENT_LOOP_LAG_WARN (not STALL_DETECTED) for a degraded-but-subcritical block', async () => {
    setEventLoopLagSettingsForTests({
      sampleIntervalMs: 25,
      warnMs: 50,
      criticalMs: 10_000, // unreachable by the synthetic block below, even under load
      cooldownMs: 0,
    });
    const warnSpy = vi.spyOn(structuredLogger, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(structuredLogger, 'error').mockImplementation(() => {});
    startEventLoopLagMonitor();
    try {
      blockLoopSync(150); // above warn (50ms), far below critical (10s)
      await new Promise((r) => setTimeout(r, 200));

      const warns = warnSpy.mock.calls.filter((c) => c[1]?.eventType === 'EVENT_LOOP_LAG_WARN');
      expect(warns.length).toBeGreaterThanOrEqual(1);
      expect((warns[0][1] as Record<string, unknown>).lagMs as number).toBeGreaterThanOrEqual(50);
      expect(getEventLoopLagStatus().stallCount).toBe(0);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      stopEventLoopLagMonitor();
      warnSpy.mockRestore();
      errSpy.mockRestore();
      resetEventLoopLagMonitorForTests();
      resetEventLoopLagSettingsForTests();
    }
  });

  it('alertEventLoopStall dispatches an event_loop_stall webhook alert, cooldown-guarded', () => {
    const svc = new AlertingService();
    svc.alertEventLoopStall({
      lagMs: 180_000,
      sampleIntervalMs: 1000,
      criticalMs: 30_000,
      stallCount: 2,
      rssMb: 900.5,
      heapUsedMb: 400.2,
    });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);
    const evt = triggerWebhooks.mock.calls[0]![0];
    expect(evt.type).toBe('event_loop_stall');
    expect(evt.message).toContain('180000');
    expect(evt.message).toContain('30000');
    expect(evt.details.stallCount).toBe(2);
    // Second immediate alert on the same key is suppressed by the alerting cooldown -
    // a prolonged stall must not spam the channel.
    svc.alertEventLoopStall({
      lagMs: 180_001,
      sampleIntervalMs: 1000,
      criticalMs: 30_000,
      stallCount: 3,
      rssMb: null,
      heapUsedMb: null,
    });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);
  });
});

describe('sync persist timing (item 1b)', () => {
  it('warns SYNC_PERSIST_SLOW at/above the config threshold, stays silent below it', () => {
    // Config-driven: the test reads the same threshold production uses.
    const thresholdMs = observabilityConfig.syncPersistWarnMs;
    const warnSpy = vi.spyOn(structuredLogger, 'warn').mockImplementation(() => {});
    try {
      checkSyncPersistDuration('SYNTHETIC_SEEDED:callSite', thresholdMs - 1);
      expect(warnSpy).not.toHaveBeenCalled();

      checkSyncPersistDuration('SYNTHETIC_SEEDED:callSite', thresholdMs);
      checkSyncPersistDuration('SYNTHETIC_SEEDED:callSite', thresholdMs + 500);
      const slowCalls = warnSpy.mock.calls.filter((c) => c[1]?.eventType === 'SYNC_PERSIST_SLOW');
      expect(slowCalls.length).toBe(2);
      expect(slowCalls[0][1]).toMatchObject({
        callSite: 'SYNTHETIC_SEEDED:callSite',
        thresholdMs,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('timeSyncPersist returns the wrapped value unchanged and never alters throw semantics', () => {
    expect(timeSyncPersist('SYNTHETIC_SEEDED:fast', () => 42)).toBe(42);
    expect(() =>
      timeSyncPersist('SYNTHETIC_SEEDED:throwing', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('timeSyncPersist warns on an injected slow persist without changing the result', () => {
    const thresholdMs = observabilityConfig.syncPersistWarnMs;
    const warnSpy = vi.spyOn(structuredLogger, 'warn').mockImplementation(() => {});
    try {
      const result = timeSyncPersist('SYNTHETIC_SEEDED:slowPersist', () => {
        blockLoopSync(thresholdMs + 100); // injected slow commit, SYNTHETIC_SEEDED
        return 'persisted';
      });
      expect(result).toBe('persisted');
      const slowCalls = warnSpy.mock.calls.filter((c) => c[1]?.eventType === 'SYNC_PERSIST_SLOW');
      expect(slowCalls.length).toBe(1);
      expect((slowCalls[0][1] as Record<string, unknown>).durationMs as number).toBeGreaterThanOrEqual(
        thresholdMs,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('timeAsyncPersist warns on an injected slow async persist and passes the value through', async () => {
    const thresholdMs = observabilityConfig.syncPersistWarnMs;
    const warnSpy = vi.spyOn(structuredLogger, 'warn').mockImplementation(() => {});
    try {
      const result = await timeAsyncPersist('SYNTHETIC_SEEDED:slowAsyncPersist', async () => {
        blockLoopSync(thresholdMs + 100);
        return 7;
      });
      expect(result).toBe(7);
      const slowCalls = warnSpy.mock.calls.filter((c) => c[1]?.eventType === 'SYNC_PERSIST_SLOW');
      expect(slowCalls.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('cooperative cancellation of superseded Quant evaluations (item 1c)', () => {
  it('throwIfSuperseded is a no-op without a predicate or while the evaluation is live', () => {
    expect(() => throwIfSuperseded(undefined, 'SYN', 't', 'postEnsureBars')).not.toThrow();
    // Legacy callers that predate isLiveCheck pass no predicate - completely unaffected.
    expect(() =>
      throwIfSuperseded({} as never, 'SYN', 't', 'postEnsureBars'),
    ).not.toThrow();
    expect(() =>
      throwIfSuperseded({ isLiveCheck: () => true }, 'SYN', 't', 'postEnsureBars'),
    ).not.toThrow();
  });

  it('a broken isLiveCheck predicate fails open - never cancels a live evaluation', () => {
    expect(() =>
      throwIfSuperseded(
        {
          isLiveCheck: () => {
            throw new Error('predicate exploded');
          },
        },
        'SYN',
        't',
        'postEnsureBars',
      ),
    ).not.toThrow();
  });

  it('a superseded evaluation throws QuantEvalSupersededError and emits only QUANT_EVAL_CANCELLED_SUPERSEDED', () => {
    const infoSpy = vi.spyOn(structuredLogger, 'info').mockImplementation(() => {});
    try {
      let thrown: unknown;
      try {
        throwIfSuperseded({ isLiveCheck: () => false }, 'SYNTH', 'trace-synth-1', 'prePersist');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(QuantEvalSupersededError);
      const err = thrown as QuantEvalSupersededError;
      expect(err.symbol).toBe('SYNTH');
      expect(err.stage).toBe('prePersist');
      expect(err.name).toBe('QuantEvalSupersededError');

      const cancelCalls = infoSpy.mock.calls.filter(
        (c) => c[1]?.eventType === 'QUANT_EVAL_CANCELLED_SUPERSEDED',
      );
      expect(cancelCalls.length).toBe(1);
      expect(cancelCalls[0][1]).toMatchObject({
        symbol: 'SYNTH',
        traceId: 'trace-synth-1',
        stage: 'prePersist',
      });

      // The throw path emits no idea, no assessment, and no assessment-completed event -
      // the cancellation marker is the only observability record.
      const emissionish = infoSpy.mock.calls.filter((c) =>
        /TRADE_IDEA|QUANT_ASSESSMENT/i.test(String(c[1]?.eventType ?? '')),
      );
      expect(emissionish.length).toBe(0);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('post-replacement resource use is bounded: no stage executes after the token flips', () => {
    // Mirrors the real stage sequence in QuantSignalAgent.evaluateSymbolInternal:
    // postEnsureBars -> primaryBars -> intradayFetch -> marketContext -> lifecycleFilter ->
    // evGate -> preAiReview -> aiContradiction -> internalEnsemble -> prePersist.
    const stages = [
      'postEnsureBars',
      'primaryBars',
      'intradayFetch',
      'marketContext',
      'lifecycleFilter',
      'evGate',
      'preAiReview',
      'aiContradiction',
      'internalEnsemble',
      'prePersist',
    ];
    const runStages = (liveAt: (stage: string) => boolean): string[] => {
      const executed: string[] = [];
      try {
        for (const stage of stages) {
          throwIfSuperseded({ isLiveCheck: () => liveAt(stage) }, 'SYNTH', 'trace-synth-2', stage);
          executed.push(stage); // stands in for the stage's expensive work
        }
      } catch (e) {
        if (!(e instanceof QuantEvalSupersededError)) throw e;
        // Expected: cooperative cancellation. In production this exact error class is what
        // QuantSignalAgent.evaluateSymbol's catch maps to outcome 'SUPERSEDED_CANCELLED' and a
        // null return (the established "no evaluation" return, same as insufficient-bars), so
        // no QUANT_ASSESSMENT_COMPLETED event fires and no quant_assessments row is written -
        // the 486d51f generation-token fence at emission stands behind it as defense in depth.
      }
      return executed;
    };

    // Never superseded: every stage runs, no spurious cancellation.
    expect(runStages(() => true)).toHaveLength(stages.length);

    // Replaced right after 'primaryBars': the bar fetch it was inside rides out, but nothing
    // after it executes - no intraday fetch, no feature compute, no AI review, no Java
    // ensemble HTTP call, no SQLite writes, no emission. Bounded at exactly the pre-flip work.
    expect(runStages((stage) => stage === 'postEnsureBars' || stage === 'primaryBars')).toEqual([
      'postEnsureBars',
      'primaryBars',
    ]);

    // Replaced before the first stage: zero stages execute.
    expect(runStages(() => false)).toEqual([]);
  });
});
