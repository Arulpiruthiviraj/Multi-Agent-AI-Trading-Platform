import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { eventBus } from './EventBus';

describe('EventBus.emit - per-listener isolation (Phase 16A follow-up)', () => {
  it('still runs later listeners when an earlier one throws (Node default does not)', () => {
    const second = vi.fn();
    const event = `isolation-${Date.now()}-${Math.random()}`;
    eventBus.on(event, () => { throw new Error('first listener boom'); });
    eventBus.on(event, second);

    expect(() => eventBus.emit(event, { ok: true })).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ ok: true });
  });

  it('documents the contrast: stock EventEmitter aborts the remaining chain', () => {
    const stock = new EventEmitter();
    const second = vi.fn();
    stock.on('x', () => { throw new Error('boom'); });
    stock.on('x', second);
    expect(() => stock.emit('x')).toThrow('boom');
    expect(second).not.toHaveBeenCalled();
  });
});
