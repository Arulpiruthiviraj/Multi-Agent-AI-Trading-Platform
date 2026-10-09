import { expect, it } from 'vitest';
import { summarizeQuantAdmissionLatency } from './quantAdmissionLatency';
import { quantScheduling } from '../config/quantScheduling';

const accepted = (symbol: string, ts: number, rowid: number) => ({ symbol, ts, rowid, eventType: 'MARKET_DATA_SUBSCRIPTION_OUTCOME', payload: JSON.stringify({ outcome: 'ACCEPTED' }) });
const started = (symbol: string, ts: number, rowid: number) => ({ symbol, ts, rowid, eventType: 'QUANT_SYMBOL_EVALUATION_STARTED', payload: null });
it('certifies only a complete, sufficiently sized window with causal scheduled starts', () => {
  const events = Array.from({ length: quantScheduling.admissionLatencyMinSamples }, (_, i) => [accepted(`S${i}`, 0, i * 2), started(`S${i}`, 1, i * 2 + 1)]).flat();
  expect(summarizeQuantAdmissionLatency(events, 2, true).certified).toBe(true);
  expect(summarizeQuantAdmissionLatency(events, 2, false).certified).toBe(false);
  expect(summarizeQuantAdmissionLatency([], 2, true).certified).toBe(false);
});
it('does not match a prior evaluation, and flags missing/overdue admitted work', () => {
  const result = summarizeQuantAdmissionLatency([started('MRNA', 0, 1), accepted('MRNA', 0, 2)], quantScheduling.admissionLatencyTargetMs + 1, true);
  expect(result.measured).toHaveLength(0);
  expect(result.overdue).toHaveLength(1);
  expect(result.certified).toBe(false);
});
it('flags real elapsed violations and malformed acceptance records', () => {
  const result = summarizeQuantAdmissionLatency([accepted('CRCL', 0, 1), started('CRCL', quantScheduling.admissionLatencyTargetMs + 1, 2)], quantScheduling.admissionLatencyTargetMs + 2, true);
  expect(result.violations).toHaveLength(1);
  expect(result.certified).toBe(false);
  expect(summarizeQuantAdmissionLatency([{ ...accepted('SPY', 0, 1), payload: 'broken' }], 2, true).complete).toBe(false);
});
