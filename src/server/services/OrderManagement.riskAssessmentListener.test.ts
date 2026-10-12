import { describe, it, expect, vi, beforeEach } from 'vitest';
import { structuredLogger } from '../observability/StructuredLogger';

// 2026-10-12 defect hunt (L4): the async RISK_ASSESSMENT_COMPLETED listener in
// OrderManagementService's constructor must never reject unhandled - a throw from
// executeOrder() (broker/DB outage) previously dropped the order silently. These tests
// drive the REAL listener through a capturing EventBus mock (emit awaits listeners),
// with executeOrder stubbed so no broker or DB is touched.

const { capturedListeners, busEmit } = vi.hoisted(() => {
  const listeners = new Map<string, Array<(p: any) => unknown>>();
  const busEmit = async (event: string, payload: any) => {
    for (const fn of listeners.get(event) ?? []) {
      await fn(payload);
    }
    return true;
  };
  return { capturedListeners: listeners, busEmit };
});

vi.mock('../core/EventBus', () => ({
  eventBus: {
    on: (event: string, fn: (p: any) => unknown) => {
      const arr = capturedListeners.get(event) ?? [];
      arr.push(fn);
      capturedListeners.set(event, arr);
    },
    emit: busEmit,
    off: vi.fn(),
  },
}));

vi.mock('../db', () => ({
  db: {
    select: () => { throw new Error('db must not be touched in this test'); },
  },
}));

// Cut the heavy module chains (BrokerManager/TradingEngine pull SystemBootstrap, which
// needs real db exports) - same isolation pattern as OrderManagement.test.ts. The
// listener path under test never reaches them; executeOrder is stubbed per-test.
vi.mock('./positionFillEvidence', () => ({ prepareOrderPosition: () => null, applyPositionFill: () => true }));
vi.mock('../../brokers/BrokerManager', () => ({
  BrokerManager: {
    getInstance: () => ({
      getActiveBroker: () => { throw new Error('no broker in this test'); },
      getBroker: () => undefined,
    }),
  },
}));
vi.mock('../engines/TradingEngine', () => ({
  tradingEngine: { setTradingState: vi.fn(), state: {} },
}));

import { eventBus } from '../core/EventBus';
import { OrderManagementService } from './OrderManagement';

const approvedAssessment = () => ({
  approved: true,
  maxQuantity: 5,
  symbol: 'AAPL',
  side: 'BUY',
  reasoning: 'test approval',
  traceId: 'trace-123',
  newsDetails: undefined,
  transactionId: 'txn-456',
  selectedQuantStrategy: 'MOMENTUM_BREAKOUT',
  quantStopPrice: 170.0,
  quantTargetPrice: 190.0,
  quantInvalidationJson: null,
  currentPrice: 180.5,
});

describe('OrderManagementService RISK_ASSESSMENT_COMPLETED listener (L4)', () => {
  let oms: OrderManagementService;
  let executeOrderSpy: ReturnType<typeof vi.spyOn>;
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedListeners.clear();
    vi.clearAllMocks();
    loggerErrorSpy = vi.spyOn(structuredLogger, 'error').mockImplementation(() => {});
    oms = new OrderManagementService();
    executeOrderSpy = vi.spyOn(oms as any, 'executeOrder').mockResolvedValue(undefined);
  });

  it('approved assessment invokes executeOrder with the assessment order fields', async () => {
    const a = approvedAssessment();
    await eventBus.emit('RISK_ASSESSMENT_COMPLETED', a);
    expect(executeOrderSpy).toHaveBeenCalledTimes(1);
    expect(executeOrderSpy).toHaveBeenCalledWith(
      a.symbol, a.side, a.maxQuantity, a.reasoning, a.traceId, a.newsDetails,
      a.transactionId, a.selectedQuantStrategy, a.quantStopPrice, a.quantTargetPrice,
      a.quantInvalidationJson, a.currentPrice,
    );
  });

  it('executeOrder throwing never rejects the listener unhandled and the error is logged', async () => {
    executeOrderSpy.mockRejectedValue(new Error('broker exploded'));
    const a = approvedAssessment();
    // If the listener rejected, this await would throw (unhandled rejection at emit).
    await expect(eventBus.emit('RISK_ASSESSMENT_COMPLETED', a)).resolves.toBe(true);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    const [eventName, fields] = loggerErrorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(eventName).toBe('oms_risk_assessment_listener_failed');
    expect(fields.eventType).toBe('OMS_RISK_ASSESSMENT_LISTENER_FAILED');
    expect(fields.symbol).toBe('AAPL');
    expect(String(fields.error)).toMatch(/broker exploded/);
  });

  it('unapproved assessment does not reach executeOrder', async () => {
    await eventBus.emit('RISK_ASSESSMENT_COMPLETED', { ...approvedAssessment(), approved: false });
    expect(executeOrderSpy).not.toHaveBeenCalled();
  });

  it('telemetry-pulse payload never reaches executeOrder', async () => {
    await eventBus.emit('RISK_ASSESSMENT_COMPLETED', { ...approvedAssessment(), telemetryPulse: true });
    expect(executeOrderSpy).not.toHaveBeenCalled();
  });
});
