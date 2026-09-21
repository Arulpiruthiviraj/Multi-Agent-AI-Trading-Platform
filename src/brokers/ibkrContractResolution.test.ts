import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { EventName } from '@stoqey/ib';
import {
  resolveIbkrContract,
  buildCandidateContractSymbols,
  getCachedIbkrContractResolution,
  resetIbkrContractResolutionCacheForTests,
} from './ibkrContractResolution';

/** Minimal fake IBApi - only the surface resolveIbkrContract actually uses. */
class FakeIb extends EventEmitter {
  reqContractDetails = vi.fn();
}

let reqIdSeq = 1;
const nextReqId = () => reqIdSeq++;

describe('buildCandidateContractSymbols', () => {
  it('returns just the symbol for a plain ticker (no dot)', () => {
    expect(buildCandidateContractSymbols('AAPL')).toEqual(['AAPL']);
  });

  it('adds a space-variant candidate for a dotted share-class symbol, raw form first', () => {
    expect(buildCandidateContractSymbols('BRK.B')).toEqual(['BRK.B', 'BRK B']);
  });
});

describe('resolveIbkrContract', () => {
  beforeEach(() => {
    resetIbkrContractResolutionCacheForTests();
    reqIdSeq = 1;
  });

  it('RESOLVED: a plain symbol with exactly one contractDetails match', async () => {
    const ib = new FakeIb();
    ib.reqContractDetails.mockImplementation((reqId: number) => {
      queueMicrotask(() => {
        ib.emit(EventName.contractDetails, reqId, {
          contract: { symbol: 'AAPL', secType: 'STK', exchange: 'SMART', primaryExch: 'NASDAQ', currency: 'USD', conId: 265598 },
        });
        ib.emit(EventName.contractDetailsEnd, reqId);
      });
    });

    const outcome = await resolveIbkrContract(ib as any, 'AAPL', nextReqId);
    expect(outcome.status).toBe('RESOLVED');
    if (outcome.status === 'RESOLVED') {
      expect(outcome.contract.symbol).toBe('AAPL');
      expect(outcome.contract.primaryExchange).toBe('NASDAQ');
      expect(outcome.contract.conId).toBe(265598);
      expect(outcome.contract.matchedCandidateSymbol).toBe('AAPL');
    }
    expect(getCachedIbkrContractResolution('AAPL')?.status).toBe('RESOLVED');
  });

  it('RESOLVED via the second candidate: raw dotted symbol returns 0 matches, space-variant returns exactly 1', async () => {
    const ib = new FakeIb();
    ib.reqContractDetails.mockImplementation((reqId: number, contract: any) => {
      queueMicrotask(() => {
        if (contract.symbol === 'BRK.B') {
          ib.emit(EventName.contractDetailsEnd, reqId); // zero matches
        } else if (contract.symbol === 'BRK B') {
          ib.emit(EventName.contractDetails, reqId, {
            contract: { symbol: 'BRK B', secType: 'STK', exchange: 'SMART', primaryExch: 'NYSE', currency: 'USD', conId: 42 },
          });
          ib.emit(EventName.contractDetailsEnd, reqId);
        }
      });
    });

    const outcome = await resolveIbkrContract(ib as any, 'BRK.B', nextReqId);
    expect(outcome.status).toBe('RESOLVED');
    if (outcome.status === 'RESOLVED') {
      expect(outcome.contract.matchedCandidateSymbol).toBe('BRK B');
      expect(outcome.contract.primaryExchange).toBe('NYSE');
    }
    // Verified via real IBKR qualification, not a blind string-replace guess: both candidates
    // actually went through reqContractDetails.
    expect(ib.reqContractDetails).toHaveBeenCalledTimes(2);
  });

  it('AMBIGUOUS: fails closed and never guesses among multiple real matches', async () => {
    const ib = new FakeIb();
    ib.reqContractDetails.mockImplementation((reqId: number) => {
      queueMicrotask(() => {
        ib.emit(EventName.contractDetails, reqId, { contract: { symbol: 'FOO', conId: 1 } });
        ib.emit(EventName.contractDetails, reqId, { contract: { symbol: 'FOO', conId: 2 } });
        ib.emit(EventName.contractDetailsEnd, reqId);
      });
    });

    const outcome = await resolveIbkrContract(ib as any, 'FOO', nextReqId);
    expect(outcome.status).toBe('AMBIGUOUS');
    if (outcome.status === 'AMBIGUOUS') expect(outcome.candidateCount).toBe(2);
    expect(getCachedIbkrContractResolution('FOO')?.status).toBe('AMBIGUOUS');
  });

  it('NOT_FOUND: a stale/renamed ticker with zero matches on every candidate', async () => {
    const ib = new FakeIb();
    ib.reqContractDetails.mockImplementation((reqId: number) => {
      queueMicrotask(() => ib.emit(EventName.contractDetailsEnd, reqId));
    });

    const outcome = await resolveIbkrContract(ib as any, 'SQ', nextReqId);
    expect(outcome.status).toBe('NOT_FOUND');
    expect(getCachedIbkrContractResolution('SQ')?.status).toBe('NOT_FOUND');
  });

  it('caches a successful resolution - a second call does not re-query IBKR', async () => {
    const ib = new FakeIb();
    ib.reqContractDetails.mockImplementation((reqId: number) => {
      queueMicrotask(() => {
        ib.emit(EventName.contractDetails, reqId, { contract: { symbol: 'SPY', conId: 756733 } });
        ib.emit(EventName.contractDetailsEnd, reqId);
      });
    });

    await resolveIbkrContract(ib as any, 'SPY', nextReqId);
    await resolveIbkrContract(ib as any, 'SPY', nextReqId);
    expect(ib.reqContractDetails).toHaveBeenCalledTimes(1);
  });

  it('ERROR outcomes are not cached - a transient failure is retried on the next call', async () => {
    const ib = new FakeIb();
    let attempt = 0;
    ib.reqContractDetails.mockImplementation((reqId: number) => {
      attempt++;
      queueMicrotask(() => {
        if (attempt === 1) {
          ib.emit(EventName.error, new Error('transient'), 502, reqId);
        } else {
          ib.emit(EventName.contractDetails, reqId, { contract: { symbol: 'MSFT', conId: 7 } });
          ib.emit(EventName.contractDetailsEnd, reqId);
        }
      });
    });

    const first = await resolveIbkrContract(ib as any, 'MSFT', nextReqId);
    expect(first.status).toBe('ERROR');
    expect(getCachedIbkrContractResolution('MSFT')).toBeNull();

    const second = await resolveIbkrContract(ib as any, 'MSFT', nextReqId);
    expect(second.status).toBe('RESOLVED');
  });
});
