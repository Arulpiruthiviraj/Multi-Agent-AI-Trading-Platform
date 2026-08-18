import React from 'react';
import { MobilePositionsOrders } from '../MobilePositionsOrders';
import { MobileClosedTrades } from '../MobileClosedTrades';

export function MobilePositionsView() {
  return (
    <div className="space-y-4 p-3">
      <MobilePositionsOrders />
      <MobileClosedTrades />
    </div>
  );
}
