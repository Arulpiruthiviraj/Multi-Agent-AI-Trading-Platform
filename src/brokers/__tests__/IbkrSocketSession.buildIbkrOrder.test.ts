import { describe, it, expect } from 'vitest';
import { OrderType, OrderAction } from '@stoqey/ib';
import { buildIbkrOrder } from '../IbkrSocketSession';

describe('buildIbkrOrder (Extended-Hours Execution Policy, 2026-09-05)', () => {
  it('builds a plain MARKET order with no outsideRth field at all - zero behavior change for the common case', () => {
    const order = buildIbkrOrder(1, { side: 'BUY', quantity: 10, type: 'MARKET' });
    expect(order.orderType).toBe(OrderType.MKT);
    expect(order.action).toBe(OrderAction.BUY);
    expect(order.tif).toBe('DAY');
    expect('outsideRth' in order).toBe(false);
  });

  it('sets outsideRth:true for a LIMIT order with extendedHours requested', () => {
    const order = buildIbkrOrder(2, { side: 'BUY', quantity: 5, type: 'LIMIT', limitPrice: 150.25, extendedHours: true });
    expect(order.orderType).toBe(OrderType.LMT);
    expect(order.lmtPrice).toBe(150.25);
    expect(order.outsideRth).toBe(true);
  });

  it('never sets outsideRth for a MARKET order, even if extendedHours is requested - no blind market orders outside RTH', () => {
    const order = buildIbkrOrder(3, { side: 'BUY', quantity: 5, type: 'MARKET', extendedHours: true });
    expect('outsideRth' in order).toBe(false);
  });

  it('never sets outsideRth for a LIMIT order when extendedHours is not requested', () => {
    const order = buildIbkrOrder(4, { side: 'SELL', quantity: 5, type: 'LIMIT', limitPrice: 100, extendedHours: false });
    expect('outsideRth' in order).toBe(false);
  });

  it('a STOP order sets auxPrice, unaffected by extendedHours', () => {
    const order = buildIbkrOrder(5, { side: 'SELL', quantity: 5, type: 'STOP', stopPrice: 95, extendedHours: true });
    expect(order.orderType).toBe(OrderType.STP);
    expect(order.auxPrice).toBe(95);
    expect('outsideRth' in order).toBe(false);
  });
});
