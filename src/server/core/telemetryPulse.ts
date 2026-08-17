/**
 * Digital Twin telemetry pulse — synthetic EventBus sequence for UI animation only.
 * Payloads are tagged telemetryPulse:true and MUST be ignored by ChiefTrader / RiskAgent / OMS.
 * Never places orders. Never invents organic paper evidence.
 */
import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';
import { v4 as uuidv4 } from 'uuid';

export const TELEMETRY_PULSE_TRACE_PREFIX = 'telemetry-pulse-';

export function isTelemetryPulsePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (p.telemetryPulse === true || p.diagnosticTelemetry === true) return true;
  const tid = String(p.traceId || '');
  return tid.startsWith(TELEMETRY_PULSE_TRACE_PREFIX);
}

export type TelemetryPulseMode = 'approve' | 'reject';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function startDigitalTwinTelemetryPulse(opts?: {
  mode?: TelemetryPulseMode;
  symbol?: string;
}): { ok: true; traceId: string; mode: TelemetryPulseMode; canPlaceOrders: false } {
  const mode: TelemetryPulseMode = opts?.mode === 'reject' ? 'reject' : 'approve';
  const symbol = opts?.symbol || 'AAPL';
  const traceId = `${TELEMETRY_PULSE_TRACE_PREFIX}${uuidv4()}`;
  void runDigitalTwinTelemetryPulse({ mode, symbol, traceId }).catch((e) => {
    console.error('[telemetryPulse] sequence failed', e);
  });
  return { ok: true, traceId, mode, canPlaceOrders: false };
}

/**
 * Emits a timed mock decision-path sequence for Agent Network visualization.
 * mode=approve: MARKET → IDEA → CHIEF_APPROVED → RISK pass → ORDER_EXECUTED
 * mode=reject: MARKET → IDEA → CHIEF NO_CONSENSUS + DESK_NO_TRADE → RISK reject flash
 */
export async function runDigitalTwinTelemetryPulse(opts?: {
  mode?: TelemetryPulseMode;
  symbol?: string;
  traceId?: string;
}): Promise<{ ok: true; traceId: string; mode: TelemetryPulseMode; canPlaceOrders: false }> {
  const mode: TelemetryPulseMode = opts?.mode === 'reject' ? 'reject' : 'approve';
  const symbol = opts?.symbol || 'AAPL';
  const traceId = opts?.traceId || `${TELEMETRY_PULSE_TRACE_PREFIX}${uuidv4()}`;
  const base = {
    traceId,
    telemetryPulse: true,
    diagnosticTelemetry: true,
    canPlaceOrders: false as const,
    source: 'TELEMETRY_PULSE',
  };

  eventBus.emit(EVENTS.MARKET_DATA, {
    ...base,
    symbol,
    price: 188.42,
    volume: 12_500,
    timestamp: new Date().toISOString(),
  });

  await sleep(500);
  eventBus.emit(EVENTS.TRADE_IDEA_GENERATED, {
    ...base,
    symbol,
    side: 'BUY',
    confidence: 0.82,
    reasoning: 'TELEMETRY_PULSE — synthetic TechnicalAgent idea (UI only)',
    agent: 'TechnicalAgent',
    currentPrice: 188.42,
  });

  await sleep(400);
  eventBus.emit(EVENTS.CHIEF_CONSENSUS_STARTED, {
    ...base,
    symbol,
  });

  await sleep(300);

  if (mode === 'reject') {
    eventBus.emit(EVENTS.CHIEF_CONSENSUS_COMPLETED, {
      ...base,
      symbol,
      approved: false,
      confidence: 0.41,
      side: 'BUY',
      threshold: 0.75,
      reason: 'NO_CONSENSUS',
    });
    eventBus.emit(EVENTS.DESK_NO_TRADE, {
      ...base,
      symbol,
      side: 'BUY',
      confidence: 0.41,
      reason: 'NO_CONSENSUS',
      code: 'NO_CONSENSUS',
    });
    eventBus.emit(EVENTS.AGENT_DISAGREEMENT, {
      ...base,
      symbol,
      detail: 'TELEMETRY_PULSE disagreement flash',
    });
    await sleep(500);
    eventBus.emit(EVENTS.RISK_ASSESSMENT_STARTED, { ...base, symbol });
    await sleep(300);
    eventBus.emit(EVENTS.RISK_ASSESSMENT_COMPLETED, {
      ...base,
      symbol,
      side: 'BUY',
      approved: false,
      maxQuantity: 0,
      reasoning: 'TELEMETRY_PULSE — synthetic RISK_REJECTED (UI only)',
      gate: 'daily_loss',
      passed: false,
    });
  } else {
    eventBus.emit(EVENTS.CHIEF_CONSENSUS_COMPLETED, {
      ...base,
      symbol,
      approved: true,
      confidence: 0.81,
      side: 'BUY',
      threshold: 0.75,
    });
    await sleep(200);
    eventBus.emit(EVENTS.CHIEF_APPROVED_IDEA, {
      ...base,
      symbol,
      side: 'BUY',
      confidence: 0.81,
      reasoning: 'TELEMETRY_PULSE — synthetic chief approval (UI only; RiskAgent ignores)',
      agentsContext: 'TechnicalAgent+QuantEngine',
      currentPrice: 188.42,
    });
    await sleep(500);
    eventBus.emit(EVENTS.RISK_ASSESSMENT_STARTED, { ...base, symbol });
    await sleep(300);
    eventBus.emit(EVENTS.RISK_ASSESSMENT_COMPLETED, {
      ...base,
      symbol,
      side: 'BUY',
      approved: true,
      maxQuantity: 5,
      reasoning: 'TELEMETRY_PULSE — synthetic 24-gate pass (UI only; OMS ignores)',
      passed: true,
      currentPrice: 188.42,
    });
    await sleep(400);
    eventBus.emit(EVENTS.ORDER_SUBMITTED, {
      ...base,
      symbol,
      side: 'BUY',
      quantity: 5,
      status: 'PENDING',
    });
    await sleep(200);
    eventBus.emit(EVENTS.ORDER_EXECUTED, {
      ...base,
      symbol,
      side: 'BUY',
      quantity: 5,
      price: 188.45,
      status: 'FILLED',
      executionEnvironment: 'TELEMETRY_PULSE',
      reasoning: 'TELEMETRY_PULSE — simulated paper fill for UI only (not organic paper)',
    });
  }

  return { ok: true, traceId, mode, canPlaceOrders: false };
}
