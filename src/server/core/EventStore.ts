import { eventBus } from './EventBus';

export const recentEvents: any[] = [];
export const tradeTraces: Record<string, any[]> = {};

const trackEvent = (type: string) => (payload: any) => {
  const evt = {
    id: Math.random().toString(36).substring(7),
    type,
    payload,
    timestamp: payload.timestamp || new Date().toISOString()
  };
  
  recentEvents.unshift(evt);
  if (recentEvents.length > 200) {
    recentEvents.pop();
  }
  
  if (payload.traceId) {
    if (!tradeTraces[payload.traceId]) tradeTraces[payload.traceId] = [];
    tradeTraces[payload.traceId].push(evt);
  }
};

eventBus.on('MARKET_DATA', trackEvent('MARKET_DATA'));
eventBus.on('CALCULATION_COMPLETED', trackEvent('CALCULATION_COMPLETED'));
eventBus.on('TRADE_IDEA_GENERATED', trackEvent('TRADE_IDEA_GENERATED'));
eventBus.on('CHIEF_APPROVED_IDEA', trackEvent('CHIEF_APPROVED_IDEA'));
eventBus.on('RISK_ASSESSMENT_COMPLETED', trackEvent('RISK_ASSESSMENT_COMPLETED'));
eventBus.on('ORDER_EXECUTED', trackEvent('ORDER_EXECUTED'));
eventBus.on('NEW_RULE_LEARNED', trackEvent('NEW_RULE_LEARNED'));
