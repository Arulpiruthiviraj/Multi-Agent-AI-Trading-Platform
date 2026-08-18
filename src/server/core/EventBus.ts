import { EventEmitter } from 'events';
import { EVENTS } from './eventNames';
import { tracingConfig } from '../config/tracing';
import { eventName } from './eventNames';

const CORE_EVENTS_REQUIRING_TRACE_ID = new Set(
  tracingConfig.coreEventsRequiringTraceId.map(k => eventName(k)),
);

function assertTraceId(event: string, payload: any): void {
  if (!tracingConfig.requireTraceIdOnCoreEvents) return;
  if (!CORE_EVENTS_REQUIRING_TRACE_ID.has(event)) return;
  if (payload?.telemetryPulse || payload?.diagnosticTelemetry) return;
  if (String(payload?.traceId || '').startsWith('telemetry-pulse-')) return;
  if (!payload?.traceId) {
    const msg = `[EventBus] Missing traceId on core event ${event}`;
    if (tracingConfig.warnOnlyOnMissingTraceId) {
      console.warn(msg, { symbol: payload?.symbol, agent: payload?.agent });
    } else {
      throw new Error(msg);
    }
  }
}

class EventBus extends EventEmitter {
  private static instance: EventBus;

  private constructor() {
    super();
    this.setMaxListeners(50);
  }

  public static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  public publish(event: string, payload: any) {
    assertTraceId(event, payload);
    this.emit(event, payload);
    if (event === EVENTS.MARKET_DATA) {
      super.emit(EVENTS.MARKET_DATA_UPDATED, payload);
    }
  }

  public subscribe(event: string, listener: (...args: any[]) => void) {
    this.on(event, listener);
  }

  public unsubscribe(event: string, listener: (...args: any[]) => void) {
    this.off(event, listener);
  }

  // Support wildcard listening
  public emit(event: string | symbol, ...args: any[]): boolean {
    // Phase 16A follow-up: Node's default EventEmitter.emit() aborts remaining listeners when
    // one throws. That is the exact class of failure that left 101 real CHIEF_APPROVED_IDEA
    // events with a RiskEngine rejection never written to transactions.status (a stale process
    // was the original 135/141 incident; this dispatch abort is the same failure class going
    // forward). Each listener is isolated - a throw is logged and the rest of the chain still
    // runs. This is a live-behavior change only on the error path: previously later listeners
    // were silently skipped; now they run. Happy-path dispatch order is unchanged.
    const named = this.rawListeners(event);
    if (event === 'error' && named.length === 0) {
      const err = args[0];
      if (err instanceof Error) throw err;
      throw new Error(`Unhandled 'error' event: ${String(err)}`);
    }
    for (const listener of named) {
      try {
        listener.apply(this, args);
      } catch (e) {
        console.error(`[EventBus] Listener for ${String(event)} threw - remaining listeners still run`, e);
      }
    }
    if (event !== '*') {
      for (const listener of this.rawListeners('*')) {
        try {
          listener.apply(this, [event, ...args]);
        } catch (e) {
          console.error('[EventBus] Wildcard listener threw - remaining listeners still run', e);
        }
      }
    }
    return named.length > 0;
  }

  // Legacy aliases
  public emitMarketData(symbol: string, price: number, volume: number, timestamp: string) {
     const payload = { symbol, price, volume, timestamp };
     this.emit(EVENTS.MARKET_DATA, payload);
     this.emit(EVENTS.MARKET_DATA_UPDATED, payload);
  }
  public emitTradeIdea(idea: any) {
     assertTraceId(EVENTS.TRADE_IDEA_GENERATED, idea);
     this.emit(EVENTS.TRADE_IDEA_GENERATED, idea);
  }
  public emitCalculation(traceId: string, engine: string, symbol: string, data: any) {
     this.emit(EVENTS.CALCULATION_COMPLETED, { traceId, engine, symbol, data });
  }
  public emitRiskAssessment(assessment: any) {
     assertTraceId(EVENTS.RISK_ASSESSMENT_COMPLETED, assessment);
     this.emit(EVENTS.RISK_ASSESSMENT_COMPLETED, assessment);
  }
  public emitOrderExecution(order: any) {
     assertTraceId(EVENTS.ORDER_EXECUTED, order);
     this.emit(EVENTS.ORDER_EXECUTED, order);
  }
  public emitLearningEvent(event: any) {
     this.emit(EVENTS.LEARNED_NEW_RULE, event);
  }
  public emitChiefApproval(approval: any) {
     assertTraceId(EVENTS.CHIEF_APPROVED_IDEA, approval);
     this.emit(EVENTS.CHIEF_APPROVED_IDEA, approval);
  }
}

export const eventBus = EventBus.getInstance();
export default eventBus;
