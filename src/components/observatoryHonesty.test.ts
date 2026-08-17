import { describe, it, expect } from 'vitest';
import { formatStatusHint, formatTransactionDecision, formatTransactionOutcome } from './observatoryHonesty';

describe('observatoryHonesty placeholders', () => {
  it('labels NO_CONSENSUS with no finalDecision as NO TRADE, not an invented BUY/SELL', () => {
    const d = formatTransactionDecision({
      finalDecision: null,
      status: 'NO_CONSENSUS',
      outcome: 'N_A',
      proposedSide: 'BUY',
      weightedConfidence: 0.62,
      consensusThreshold: 0.75,
    });
    expect(d.label).toBe('NO TRADE');
    expect(d.kind).toBe('none');
    expect(d.title).toContain('did not reach consensus');
    expect(d.title).toContain('BUY');
    expect(d.title).toContain('62.0%');
    expect(d.title).toContain('75%');
  });

  it('keeps an approved BUY as BUY', () => {
    const d = formatTransactionDecision({
      finalDecision: 'BUY',
      status: 'OPEN',
      outcome: 'PENDING',
    });
    expect(d.label).toBe('BUY');
    expect(d.kind).toBe('buy');
  });

  it('renders N_A as N/A and explains it is not a missing WIN/LOSS', () => {
    const o = formatTransactionOutcome({ outcome: 'N_A', status: 'NO_CONSENSUS' });
    expect(o.label).toBe('N/A');
    expect(o.title).toContain('Not applicable');
    expect(o.title).toContain('NO_CONSENSUS');
  });

  it('explains NO_CONSENSUS as a real closed cycle, not a blank bug', () => {
    expect(formatStatusHint('NO_CONSENSUS')).toContain('Real pipeline state');
  });
});
