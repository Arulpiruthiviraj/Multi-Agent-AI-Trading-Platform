import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../core/EventBus';
import {
  runWithObservabilityContext,
  getObservabilityContext,
  getSessionId,
} from '../observability/ObservabilityContext';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('ObservabilityContext concurrent decisions', () => {
  it('sessionId is stable for the process', () => {
    const a = getSessionId();
    const b = getSessionId();
    expect(a.startsWith('sess_')).toBe(true);
    expect(a).toBe(b);
  });

  it('does not leak decisionId across two concurrent async decisions', async () => {
    const seenA: string[] = [];
    const seenB: string[] = [];

    const decisionA = runWithObservabilityContext({ decisionId: 'trace_AAA_1_aaaa', correlationId: 'trace_AAA_1_aaaa' }, async () => {
      eventBus.emit('OBS_CONCURRENT_A', { traceId: 'trace_AAA_1_aaaa', symbol: 'AAA' });
      await delay(25);
      seenA.push(getObservabilityContext()?.decisionId || 'MISSING');
      await delay(25);
      seenA.push(getObservabilityContext()?.decisionId || 'MISSING');
    });

    const decisionB = runWithObservabilityContext({ decisionId: 'trace_BBB_1_bbbb', correlationId: 'trace_BBB_1_bbbb' }, async () => {
      eventBus.emit('OBS_CONCURRENT_B', { traceId: 'trace_BBB_1_bbbb', symbol: 'BBB' });
      await delay(10);
      seenB.push(getObservabilityContext()?.decisionId || 'MISSING');
      await delay(30);
      seenB.push(getObservabilityContext()?.decisionId || 'MISSING');
    });

    await Promise.all([decisionA, decisionB]);
    expect(seenA).toEqual(['trace_AAA_1_aaaa', 'trace_AAA_1_aaaa']);
    expect(seenB).toEqual(['trace_BBB_1_bbbb', 'trace_BBB_1_bbbb']);
  });

  it('EventBus listeners inherit payload.traceId as decisionId without inventing a second id', async () => {
    const captured: Array<string | undefined> = [];
    const event = `obs-als-${Date.now()}`;
    const listener = () => {
      captured.push(getObservabilityContext()?.decisionId);
    };
    eventBus.on(event, listener);
    eventBus.emit(event, { traceId: 'trace_XYZ_1_cdef', symbol: 'XYZ' });
    eventBus.off(event, listener);
    expect(captured).toEqual(['trace_XYZ_1_cdef']);
  });

  it('does not mutate EventBus payloads (isolation contract)', () => {
    const second = vi.fn();
    const event = `obs-payload-${Date.now()}`;
    const payload = { ok: true };
    eventBus.on(event, second);
    eventBus.emit(event, payload);
    eventBus.off(event, second);
    expect(second).toHaveBeenCalledWith({ ok: true });
    expect(payload).toEqual({ ok: true });
  });
});
