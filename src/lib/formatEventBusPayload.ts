/** Safely render TradingEngine eventBus / activity-log payloads in React. */
export function formatEventBusPayload(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
  if (typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    if (typeof o.msg === 'string') {
      const parts: string[] = [o.msg];
      if (o.symbol) parts.push(String(o.symbol));
      if (o.reason && o.reason !== o.msg) parts.push(String(o.reason));
      if (o.traceShort) parts.push(`trace:${o.traceShort}`);
      if (o.noTradeCode) parts.push(String(o.noTradeCode));
      return parts.join(' · ');
    }
    try {
      return JSON.stringify(payload);
    } catch {
      return String(payload);
    }
  }
  return String(payload);
}
