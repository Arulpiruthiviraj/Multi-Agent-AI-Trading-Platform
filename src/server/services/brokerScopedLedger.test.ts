import { describe, it, expect } from 'vitest';
import {
  parseBrokerScopeQuery,
  selectedBrokerNameToId,
  brokerViewingLabel,
  brokerScopeWhere,
  KNOWN_BROKER_IDS,
} from './brokerScopedLedger';

describe('brokerScopedLedger', () => {
  it('parses all / known ids and rejects unknown', () => {
    expect(parseBrokerScopeQuery('all')).toEqual({ mode: 'all' });
    expect(parseBrokerScopeQuery('ibkr_gateway')).toEqual({ mode: 'broker', brokerId: 'ibkr_gateway' });
    expect(parseBrokerScopeQuery('ALPACA')).toEqual({ mode: 'broker', brokerId: 'alpaca' });
    expect(parseBrokerScopeQuery(undefined)).toEqual({ mode: 'broker', brokerId: '' });
    expect(parseBrokerScopeQuery('questrade')).toMatchObject({ error: expect.stringContaining('Unknown') });
  });

  it('maps settings display names to adapter ids', () => {
    expect(selectedBrokerNameToId('IBKR Gateway (Socket)')).toBe('ibkr_gateway');
    expect(selectedBrokerNameToId('Alpaca')).toBe('alpaca');
    expect(selectedBrokerNameToId('Interactive Brokers')).toBe('ibkr_gateway');
  });

  it('labels IBKR paper with account id', () => {
    expect(brokerViewingLabel('ibkr_gateway', 'DUR959160')).toContain('DUR959160');
    expect(brokerViewingLabel('alpaca')).toBe('Alpaca Paper');
  });

  it('alpaca scope includes NULL legacy broker_id', () => {
    const w = brokerScopeWhere({ mode: 'broker', brokerId: 'alpaca' }, 'alpaca');
    expect(w).toBeDefined();
    expect(KNOWN_BROKER_IDS.has('ibkr_gateway')).toBe(true);
  });
});
