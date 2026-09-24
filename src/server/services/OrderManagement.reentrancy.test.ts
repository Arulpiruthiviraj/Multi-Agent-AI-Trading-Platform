import { describe, it, expect, vi } from 'vitest';

/**
 * Batch 2 timer/reentrancy sweep (2026-09-23): OrderManagementService.start() now runs
 * followUpOpenOrders() and the reconcileStaleOrders()+reconcileInboundBrokerOrders() pair through
 * their own singleFlightGuards (followUpGuard / crashRecoveryGuard). Existing row-level CAS
 * protection (see cancelOrder()'s own comment) already made these methods SAFE to run
 * concurrently - this guard is a pure addition that only prevents a whole redundant overlapping
 * cycle (extra broker round-trips) from starting, never changes what a single tick does. Proven
 * here directly against the real class, without touching reconciliation semantics.
 */
describe('OrderManagementService reentrancy guards', () => {
  it('followUpGuard coalesces a second overlapping followUpOpenOrders call', async () => {
    const { OrderManagementService } = await import('./OrderManagement');
    const oms = new OrderManagementService();

    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const followUpSpy = vi.spyOn(oms, 'followUpOpenOrders').mockImplementation(async () => { await gate; });

    const guard = (oms as any).followUpGuard;
    const first = guard.run(() => oms.followUpOpenOrders());
    const second = guard.run(() => oms.followUpOpenOrders());

    expect(followUpSpy).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([first, second]);

    expect(followUpSpy).toHaveBeenCalledTimes(1);
    followUpSpy.mockRestore();
  });

  it('crashRecoveryGuard coalesces a second overlapping crash-recovery cycle', async () => {
    const { OrderManagementService } = await import('./OrderManagement');
    const oms = new OrderManagementService();

    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const reconcileStaleSpy = vi.spyOn(oms, 'reconcileStaleOrders').mockImplementation(async () => { await gate; });
    const reconcileInboundSpy = vi.spyOn(oms, 'reconcileInboundBrokerOrders').mockResolvedValue(undefined);

    const guard = (oms as any).crashRecoveryGuard;
    const cycle = async () => {
      await oms.reconcileStaleOrders();
      await oms.reconcileInboundBrokerOrders();
    };
    const first = guard.run(cycle);
    const second = guard.run(cycle);

    expect(reconcileStaleSpy).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([first, second]);

    expect(reconcileStaleSpy).toHaveBeenCalledTimes(1);
    expect(reconcileInboundSpy).toHaveBeenCalledTimes(1); // only the one real (non-coalesced) cycle ran the pair
    reconcileStaleSpy.mockRestore();
    reconcileInboundSpy.mockRestore();
  });
});
