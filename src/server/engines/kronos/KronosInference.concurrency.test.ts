import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChronosForecastGate } from './KronosInference';

describe('ChronosForecastGate concurrency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes concurrent work when maxConcurrent=1', async () => {
    const gate = new ChronosForecastGate(1);
    const order: string[] = [];
    let releaseA!: () => void;
    const aBlock = new Promise<void>((r) => { releaseA = r; });

    const p1 = gate.run(async () => {
      order.push('a-start');
      await aBlock;
      order.push('a-end');
      return 'A';
    });
    // Let p1 acquire the slot
    await Promise.resolve();
    expect(gate.snapshot()).toEqual({ active: 1, waiting: 0 });

    const p2 = gate.run(async () => {
      order.push('b-start');
      order.push('b-end');
      return 'B';
    });
    await Promise.resolve();
    expect(gate.snapshot().waiting).toBe(1);
    expect(order).toEqual(['a-start']);

    releaseA();
    await expect(p1).resolves.toBe('A');
    await expect(p2).resolves.toBe('B');
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    expect(gate.snapshot()).toEqual({ active: 0, waiting: 0 });
  });

  it('allows up to maxConcurrent in flight', async () => {
    const gate = new ChronosForecastGate(2);
    let release!: () => void;
    const block = new Promise<void>((r) => { release = r; });
    const p1 = gate.run(async () => { await block; return 1; });
    const p2 = gate.run(async () => { await block; return 2; });
    await Promise.resolve();
    expect(gate.snapshot().active).toBe(2);
    expect(gate.snapshot().waiting).toBe(0);
    const p3 = gate.run(async () => 3);
    await Promise.resolve();
    expect(gate.snapshot().waiting).toBe(1);
    release();
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([1, 2, 3]);
  });
});
