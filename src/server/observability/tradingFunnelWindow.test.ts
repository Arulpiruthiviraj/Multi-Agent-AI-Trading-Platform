import { describe, it, expect } from 'vitest';
import { resolveFunnelWindowHours, FUNNEL_DEFAULT_HOURS, FUNNEL_MAX_HOURS } from './tradingFunnelReport';

// D8 (2026-10-15): a default 24 h `argus trading-funnel` ran synchronously inside the trading process and stalled the event loop ~8 s at 09:37 ET.
describe('resolveFunnelWindowHours', () => {
  it('defaults to a bounded recent window when absent or garbage', () => {
    for (const raw of [undefined, null, '', 'abc', '0', '-5', NaN]) expect(resolveFunnelWindowHours(raw)).toBe(FUNNEL_DEFAULT_HOURS);
    expect(FUNNEL_DEFAULT_HOURS).toBeLessThanOrEqual(4);
  });
  it('honours a sensible request, floors tiny windows and caps long ones', () => {
    expect(resolveFunnelWindowHours('0.67')).toBeCloseTo(0.67, 5);
    expect(resolveFunnelWindowHours('6')).toBe(6);
    expect(resolveFunnelWindowHours('0.0001')).toBeCloseTo(1 / 60, 6);
    expect(resolveFunnelWindowHours('720')).toBe(FUNNEL_MAX_HOURS);
    expect(FUNNEL_MAX_HOURS).toBeLessThan(24 * 30);
  });
});
