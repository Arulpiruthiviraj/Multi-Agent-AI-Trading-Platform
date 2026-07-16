import { EventEmitter } from 'events';

class ArgusEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(30);
  }

  emitMarketData(symbol: string, price: number, volume: number, timestamp: string) {
    this.emit('MARKET_DATA', { symbol, price, volume, timestamp });
  }

  emitCalculation(traceId: string, engine: string, symbol: string, data: any) {
    this.emit('CALCULATION_COMPLETED', { traceId, engine, symbol, data, timestamp: new Date().toISOString() });
  }

  emitTradeIdea(idea: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agent: string }) {
    this.emit('TRADE_IDEA_GENERATED', { ...idea, timestamp: new Date().toISOString() });
  }

  emitChiefApproval(idea: { traceId: string, symbol: string, side: string, confidence: number, reasoning: string, agentsContext: string }) {
    this.emit('CHIEF_APPROVED_IDEA', { ...idea, timestamp: new Date().toISOString() });
  }
  
  emitRiskAssessment(assessment: { traceId: string, symbol: string, side: string, approved: boolean, maxQuantity: number, reasoning: string }) {
    this.emit('RISK_ASSESSMENT_COMPLETED', { ...assessment, timestamp: new Date().toISOString() });
  }

  emitOrderExecution(order: { traceId: string, id: string, symbol: string, side: string, quantity: number, price: number, status: string }) {
    this.emit('ORDER_EXECUTED', { ...order, timestamp: new Date().toISOString() });
  }

  emitLearningEvent(learning: { traceId: string, agent: string, cause: string, rule: string, confidence: number }) {
    this.emit('NEW_RULE_LEARNED', { ...learning, timestamp: new Date().toISOString() });
  }
}

export const eventBus = new ArgusEventBus();
