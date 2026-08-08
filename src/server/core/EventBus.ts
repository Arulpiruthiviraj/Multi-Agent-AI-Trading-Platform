import { EventEmitter } from 'events';

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
    this.emit(event, payload);
  }

  public subscribe(event: string, listener: (...args: any[]) => void) {
    this.on(event, listener);
  }

  public unsubscribe(event: string, listener: (...args: any[]) => void) {
    this.off(event, listener);
  }

  // Support wildcard listening
  public emit(event: string | symbol, ...args: any[]): boolean {
    const result = super.emit(event, ...args);
    if (event !== '*') {
      super.emit('*', event, ...args);
    }
    return result;
  }

  // Legacy aliases
  public emitMarketData(symbol: string, price: number, volume: number, timestamp: string) {
     this.emit('MARKET_DATA', { symbol, price, volume, timestamp });
  }
  public emitTradeIdea(idea: any) {
     this.emit('TRADE_IDEA_GENERATED', idea);
  }
  public emitCalculation(traceId: string, engine: string, symbol: string, data: any) {
     this.emit('CALCULATION_COMPLETED', { traceId, engine, symbol, data });
  }
  public emitRiskAssessment(assessment: any) {
     this.emit('RISK_ASSESSMENT_COMPLETED', assessment);
  }
  public emitOrderExecution(order: any) {
     this.emit('ORDER_EXECUTED', order);
  }
  public emitLearningEvent(event: any) {
     this.emit('LEARNED_NEW_RULE', event);
  }
  public emitChiefApproval(approval: any) {
     this.emit('CHIEF_APPROVED_IDEA', approval);
  }
}

export const eventBus = EventBus.getInstance();
export default eventBus;
