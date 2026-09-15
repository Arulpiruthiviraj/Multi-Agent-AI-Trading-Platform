import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
  assertSyntheticSimulationIsolation,
  assertActiveSessionIsSynthetic,
  SyntheticSimulationIsolationError,
  productionDbPath,
  productionSessionMarkerPath,
} from './SyntheticSimulationSafety';
import { HistoricalReplayBroker } from '../../brokers/HistoricalReplayBroker';
import type { BrokerPlugin } from '../../brokers/BrokerAdapter';

describe('SyntheticSimulationSafety (Phase 1: isolation boundary + safety assertions)', () => {
  const ORIGINAL_ENV = { ...process.env };
  const isolatedDbPath = path.join(os.tmpdir(), `argus_synthetic_sim_test_${Date.now()}.db`);
  const isolatedMarkerPath = path.join(os.tmpdir(), `argus_synthetic_sim_session_${Date.now()}.json`);

  beforeEach(() => {
    process.env.SYNTHETIC_SIMULATION = 'true';
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.LIVE_ARM;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('assertSyntheticSimulationIsolation (pre-flight)', () => {
    it('passes when SYNTHETIC_SIMULATION=true, PAPER_TRADING_ONLY=true, LIVE_ARM unset, and paths are isolated', () => {
      expect(() => assertSyntheticSimulationIsolation({ dbPath: isolatedDbPath, sessionMarkerPath: isolatedMarkerPath })).not.toThrow();
    });

    it('refuses to start when SYNTHETIC_SIMULATION is not "true"', () => {
      delete process.env.SYNTHETIC_SIMULATION;
      expect(() => assertSyntheticSimulationIsolation({ dbPath: isolatedDbPath })).toThrow(SyntheticSimulationIsolationError);
      try {
        assertSyntheticSimulationIsolation({ dbPath: isolatedDbPath });
      } catch (e) {
        expect((e as SyntheticSimulationIsolationError).reasons.join(' ')).toMatch(/SYNTHETIC_SIMULATION/);
      }
    });

    it('refuses to start when PAPER_TRADING_ONLY is not "true"', () => {
      process.env.PAPER_TRADING_ONLY = 'false';
      expect(() => assertSyntheticSimulationIsolation({ dbPath: isolatedDbPath })).toThrow(/PAPER_TRADING_ONLY/);
    });

    it('refuses to start when LIVE_ARM is "true"', () => {
      process.env.LIVE_ARM = 'true';
      expect(() => assertSyntheticSimulationIsolation({ dbPath: isolatedDbPath })).toThrow(/LIVE_ARM/);
    });

    it('refuses to start when dbPath resolves to the real production database', () => {
      expect(() => assertSyntheticSimulationIsolation({ dbPath: productionDbPath() })).toThrow(/production database/);
    });

    it('refuses to start when sessionMarkerPath resolves to the real production restart-safety marker', () => {
      expect(() => assertSyntheticSimulationIsolation({ dbPath: isolatedDbPath, sessionMarkerPath: productionSessionMarkerPath() })).toThrow(/production restart-safety marker/);
    });

    it('sessionMarkerPath is optional - omitting it does not fail isolation on its own', () => {
      expect(() => assertSyntheticSimulationIsolation({ dbPath: isolatedDbPath })).not.toThrow();
    });

    it('reports every failing reason at once, not just the first', () => {
      delete process.env.SYNTHETIC_SIMULATION;
      process.env.PAPER_TRADING_ONLY = 'false';
      try {
        assertSyntheticSimulationIsolation({ dbPath: productionDbPath() });
        expect.unreachable('should have thrown');
      } catch (e) {
        const reasons = (e as SyntheticSimulationIsolationError).reasons;
        expect(reasons.length).toBeGreaterThanOrEqual(3); // SYNTHETIC_SIMULATION + PAPER_TRADING_ONLY + dbPath
      }
    });
  });

  describe('assertActiveSessionIsSynthetic (post-install)', () => {
    it('passes for HistoricalReplayBroker - the existing template for a synthetic broker', () => {
      const broker = new HistoricalReplayBroker({ initialCash: 100000 } as any);
      expect(() => assertActiveSessionIsSynthetic(broker)).not.toThrow();
    });

    it('refuses a broker that declares getCapabilities().liveTrading === true', () => {
      const fakeLiveBroker: BrokerPlugin = {
        id: 'fake_live_broker', name: 'Fake Live Broker',
        initialize: async () => {}, authenticate: async () => true, validateCredentials: async () => true,
        paperTrading: () => {}, liveTrading: () => { throw new Error('refused'); },
        getCapabilities: () => ({ liveTrading: true } as any),
        portfolio: async () => ({} as any), orders: async () => [], positions: async () => [],
        account: async () => ({}), disconnect: async () => {}, health: async () => 'OK',
        placeOrder: async () => ({} as any), cancelOrder: async () => true, closePosition: async () => true,
      };
      expect(() => assertActiveSessionIsSynthetic(fakeLiveBroker)).toThrow(/liveTrading.*true/);
    });

    it('refuses a broker whose liveTrading() does not throw (the real isolation proof, not just a capability flag)', () => {
      const brokerThatDoesNotRefuseLive: BrokerPlugin = {
        id: 'sneaky_broker', name: 'Sneaky Broker',
        initialize: async () => {}, authenticate: async () => true, validateCredentials: async () => true,
        paperTrading: () => {}, liveTrading: () => { /* does NOT throw - the dangerous case */ },
        getCapabilities: () => ({ liveTrading: false } as any), // capability flag says false, but the method itself is unguarded
        portfolio: async () => ({} as any), orders: async () => [], positions: async () => [],
        account: async () => ({}), disconnect: async () => {}, health: async () => 'OK',
        placeOrder: async () => ({} as any), cancelOrder: async () => true, closePosition: async () => true,
      };
      expect(() => assertActiveSessionIsSynthetic(brokerThatDoesNotRefuseLive)).toThrow(/did not throw/);
    });
  });
});
