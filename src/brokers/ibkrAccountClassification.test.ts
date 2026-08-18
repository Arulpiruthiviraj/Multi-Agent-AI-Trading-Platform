import { describe, it, expect } from 'vitest';
import { classifyIbkrAccountId, assertIbkrSessionAllowsOrder } from './ibkrAccountClassification';
import { loadRepoConfigJson } from '../server/config/loadRepoConfigJson';

const catalog = loadRepoConfigJson<{ paperAccountIdPrefixes: string[]; liveAccountIdPrefixes: string[] }>('ibkrAccountClassification.json');

describe('IBKR account classification', () => {
  it('classifies paper prefixes from config before live (DU is not U)', () => {
    const paperPrefix = catalog.paperAccountIdPrefixes[0];
    const livePrefix = catalog.liveAccountIdPrefixes[0];
    expect(classifyIbkrAccountId(`${paperPrefix}1234567`).kind).toBe('PAPER');
    expect(classifyIbkrAccountId(`${livePrefix}1234567`).kind).toBe('LIVE');
  });

  it('unknown ids fail closed', () => {
    expect(classifyIbkrAccountId('XYZ-UNKNOWN').kind).toBe('UNKNOWN');
    expect(classifyIbkrAccountId('').kind).toBe('UNKNOWN');
    expect(assertIbkrSessionAllowsOrder({ requestedMode: 'PAPER', accountId: 'XYZ' }).ok).toBe(false);
  });

  it('paper Argus + paper IBKR is allowed', () => {
    const paper = `${catalog.paperAccountIdPrefixes[0]}111`;
    expect(assertIbkrSessionAllowsOrder({ requestedMode: 'PAPER', accountId: paper }).ok).toBe(true);
  });

  it('paper Argus + live IBKR is refused', () => {
    const live = `${catalog.liveAccountIdPrefixes[0]}111`;
    const gate = assertIbkrSessionAllowsOrder({ requestedMode: 'PAPER', accountId: live });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/IBKR_LIVE_SESSION_IN_PAPER/);
  });

  it('live Argus + paper IBKR is refused', () => {
    const paper = `${catalog.paperAccountIdPrefixes[0]}111`;
    const gate = assertIbkrSessionAllowsOrder({ requestedMode: 'LIVE', accountId: paper });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/IBKR_PAPER_SESSION_IN_LIVE/);
  });

  it('live Argus + live IBKR is allowed at the session layer', () => {
    const live = `${catalog.liveAccountIdPrefixes[0]}111`;
    expect(assertIbkrSessionAllowsOrder({ requestedMode: 'LIVE', accountId: live }).ok).toBe(true);
  });

  it('unset requested mode fails closed', () => {
    const gate = assertIbkrSessionAllowsOrder({ requestedMode: null, accountId: `${catalog.paperAccountIdPrefixes[0]}111` });
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/IBKR_SESSION_MODE_UNKNOWN/);
  });
});
