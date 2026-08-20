import { describe, expect, it } from 'vitest';
import { defaultReplayConfig } from './ReplayContext';
import { replaySafety } from './replaySafety';

describe('defaultReplayConfig', () => {
  it('defaults to ARGUS_DISCOVERY with empty symbols when only capital + dates provided', () => {
    const c = defaultReplayConfig({
      initialCapital: 2000,
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    expect(c.universeSource).toBe('ARGUS_DISCOVERY');
    expect(c.symbols).toEqual([]);
  });

  it('infers OPERATOR_SELECTED when explicit symbols are provided', () => {
    const c = defaultReplayConfig({ symbols: ['AAPL', 'NVDA'] });
    expect(c.universeSource).toBe('OPERATOR_SELECTED');
    expect(c.symbols).toEqual(['AAPL', 'NVDA']);
  });

  it('respects explicit universeSource override', () => {
    const c = defaultReplayConfig({ universeSource: 'ARGUS_DISCOVERY', symbols: ['AAPL'] });
    expect(c.universeSource).toBe('ARGUS_DISCOVERY');
  });

  it('matches replaySafety.universeSourceDefault', () => {
    expect(replaySafety.universeSourceDefault).toBe('ARGUS_DISCOVERY');
  });
});
