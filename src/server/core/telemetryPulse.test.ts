import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eventBus } from './EventBus';
import {
  isTelemetryPulsePayload,
  runDigitalTwinTelemetryPulse,
  TELEMETRY_PULSE_TRACE_PREFIX,
} from './telemetryPulse';

describe('telemetryPulse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects tagged payloads and telemetry-pulse-* traceIds', () => {
    expect(isTelemetryPulsePayload({ telemetryPulse: true })).toBe(true);
    expect(isTelemetryPulsePayload({ diagnosticTelemetry: true })).toBe(true);
    expect(isTelemetryPulsePayload({ traceId: `${TELEMETRY_PULSE_TRACE_PREFIX}abc` })).toBe(true);
    expect(isTelemetryPulsePayload({ traceId: 'organic-trace-1', symbol: 'AAPL' })).toBe(false);
    expect(isTelemetryPulsePayload(null)).toBe(false);
  });

  it('approve mode emits tagged UI-only pipeline events without organic paper claims', async () => {
    const seen: { type: string; payload: any }[] = [];
    const handler = (type: string) => (payload: any) => seen.push({ type, payload });
    const types = [
      'MARKET_DATA',
      'TRADE_IDEA_GENERATED',
      'CHIEF_CONSENSUS_STARTED',
      'CHIEF_CONSENSUS_COMPLETED',
      'CHIEF_APPROVED_IDEA',
      'RISK_ASSESSMENT_STARTED',
      'RISK_ASSESSMENT_COMPLETED',
      'ORDER_SUBMITTED',
      'ORDER_EXECUTED',
    ];
    const unsubs = types.map((t) => {
      const fn = handler(t);
      eventBus.on(t, fn);
      return () => eventBus.off(t, fn);
    });

    const run = runDigitalTwinTelemetryPulse({ mode: 'approve', symbol: 'AAPL', traceId: `${TELEMETRY_PULSE_TRACE_PREFIX}test-approve` });
    await vi.runAllTimersAsync();
    const result = await run;

    expect(result.canPlaceOrders).toBe(false);
    expect(result.mode).toBe('approve');
    expect(seen.map((s) => s.type)).toEqual(types);
    for (const s of seen) {
      expect(s.payload.telemetryPulse).toBe(true);
      expect(String(s.payload.traceId).startsWith(TELEMETRY_PULSE_TRACE_PREFIX)).toBe(true);
      expect(s.payload.canPlaceOrders).toBe(false);
    }
    expect(seen.find((s) => s.type === 'RISK_ASSESSMENT_COMPLETED')?.payload.approved).toBe(true);
    expect(seen.find((s) => s.type === 'ORDER_EXECUTED')?.payload.executionEnvironment).toBe('TELEMETRY_PULSE');

    unsubs.forEach((u) => u());
  });

  it('reject mode emits NO_CONSENSUS + RISK reject without ORDER_EXECUTED', async () => {
    const seen: string[] = [];
    const types = [
      'MARKET_DATA',
      'TRADE_IDEA_GENERATED',
      'CHIEF_CONSENSUS_COMPLETED',
      'DESK_NO_TRADE',
      'RISK_ASSESSMENT_COMPLETED',
      'ORDER_EXECUTED',
    ];
    const unsubs = types.map((t) => {
      const fn = () => seen.push(t);
      eventBus.on(t, fn);
      return () => eventBus.off(t, fn);
    });

    const run = runDigitalTwinTelemetryPulse({ mode: 'reject', symbol: 'AAPL', traceId: `${TELEMETRY_PULSE_TRACE_PREFIX}test-reject` });
    await vi.runAllTimersAsync();
    await run;

    expect(seen).toContain('DESK_NO_TRADE');
    expect(seen).toContain('RISK_ASSESSMENT_COMPLETED');
    expect(seen).not.toContain('ORDER_EXECUTED');
    unsubs.forEach((u) => u());
  });
});
