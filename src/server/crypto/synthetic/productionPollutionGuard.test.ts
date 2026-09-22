import { describe, it, expect } from 'vitest';
import { assertSyntheticSymbol, assertNotProductionDatabasePath, assertSyntheticArtifactPath } from './productionPollutionGuard';

describe('assertSyntheticSymbol', () => {
  it('does not throw for a SYN-prefixed symbol', () => {
    expect(() => assertSyntheticSymbol('SYNALT042')).not.toThrow();
  });

  it('throws for a real-looking ticker', () => {
    expect(() => assertSyntheticSymbol('AAPL')).toThrow(/PRODUCTION_POLLUTION_GUARD/);
    expect(() => assertSyntheticSymbol('BTC-USD')).toThrow(/PRODUCTION_POLLUTION_GUARD/);
  });
});

describe('assertNotProductionDatabasePath', () => {
  it('does not throw for an isolated synthetic path', () => {
    expect(() => assertNotProductionDatabasePath('data/argus-synthetic/run-1.db')).not.toThrow();
  });

  it('throws for the real production database path', () => {
    expect(() => assertNotProductionDatabasePath('data/argus.db')).toThrow(/PRODUCTION_POLLUTION_GUARD/);
    expect(() => assertNotProductionDatabasePath('data\\argus.db')).toThrow(/PRODUCTION_POLLUTION_GUARD/);
  });
});

describe('assertSyntheticArtifactPath', () => {
  it('does not throw for a path under data/argus-synthetic/', () => {
    expect(() => assertSyntheticArtifactPath('data/argus-synthetic/experiments/registry.jsonl')).not.toThrow();
  });

  it('throws for a path outside data/argus-synthetic/', () => {
    expect(() => assertSyntheticArtifactPath('data/argus.db')).toThrow(/PRODUCTION_POLLUTION_GUARD/);
    expect(() => assertSyntheticArtifactPath('data/experiments/registry.jsonl')).toThrow(/PRODUCTION_POLLUTION_GUARD/);
  });
});
