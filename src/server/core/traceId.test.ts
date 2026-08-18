import { describe, it, expect } from 'vitest';
import { generateTraceId, isFormattedTraceId } from '../core/traceId';

describe('generateTraceId', () => {
  it('produces trace_SYMBOL_UNIX_HEX4 format', () => {
    const id = generateTraceId('AAPL');
    expect(id).toMatch(/^trace_AAPL_\d+_[0-9a-f]{4}$/);
    expect(isFormattedTraceId(id)).toBe(true);
  });

  it('normalizes symbol to uppercase alphanumeric', () => {
    const id = generateTraceId('nvda!');
    expect(id.startsWith('trace_NVDA_')).toBe(true);
  });
});
