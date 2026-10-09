import { expect, it } from 'vitest';
import { QuantAdmissionQueue } from './QuantAdmissionQueue';
import { quantScheduling } from '../config/quantScheduling';

it('admits new symbols between evaluations but bounds their consecutive priority turns', () => {
  const q = new QuantAdmissionQueue(['SPY', 'QQQ', 'AAPL'], quantScheduling.maxAdmissionBurst);
  expect(q.take()).toBe('SPY');
  const newSymbols = Array.from({ length: quantScheduling.maxAdmissionBurst + 1 }, (_, i) => `N${i}`);
  q.refresh(['SPY', 'QQQ', 'AAPL', ...newSymbols]);
  for (let i = 0; i < quantScheduling.maxAdmissionBurst; i++) expect(q.take()).toBe(newSymbols[i]);
  expect(q.take()).toBe('QQQ');
  expect(q.take()).toBe(newSymbols.at(-1));
});
it('drops evicted work, deduplicates repeated refresh and never repeats an attempted re-admission', () => {
  const q = new QuantAdmissionQueue(['SPY', 'AAPL'], quantScheduling.maxAdmissionBurst);
  expect(q.take()).toBe('SPY');
  q.refresh(['SPY', 'MRNA', 'MRNA']);
  q.refresh(['SPY', 'MRNA']);
  expect(q.pending()).toEqual(['MRNA']);
  expect(q.take()).toBe('MRNA');
  q.refresh([]);
  q.refresh(['SPY', 'MRNA']);
  expect(q.take()).toBeUndefined();
});
