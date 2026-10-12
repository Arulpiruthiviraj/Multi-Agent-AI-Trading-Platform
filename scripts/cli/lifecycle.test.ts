import { describe, it, expect } from 'vitest';
import {
  buildEngineEnv,
  reconciliationIsClean,
  shouldRestoreTrading,
  waitForCleanReconciliation,
  DEFAULT_START_TIMEOUT_MS,
  type ReconciliationSnapshot,
} from './lifecycle';

const clean: ReconciliationSnapshot = { tradingState: 'TRADING_PAUSED', broker: { syncState: 'READY' }, latest: { mismatches: [], matches: 1 } };
const blip: ReconciliationSnapshot = {
  tradingState: 'TRADING_PAUSED', broker: { syncState: 'READY' },
  latest: { mismatches: [{ type: 'DISCREPANCY_CONFIRMATION_PENDING' }], matches: 0 },
};

describe('start timeout', () => {
  it('is longer than the measured ~155-170 s boot so a normal start is never reported as a failure', () => {
    expect(DEFAULT_START_TIMEOUT_MS).toBeGreaterThan(200_000);
  });
});

describe('buildEngineEnv (Ollama is opt-in)', () => {
  it('skips Ollama by default', () => {
    expect(buildEngineEnv({}, { withOllama: false }).ARGUS_SKIP_OLLAMA).toBe('true');
  });
  it('--with-ollama opts back in', () => {
    expect(buildEngineEnv({}, { withOllama: true }).ARGUS_SKIP_OLLAMA).toBe('false');
  });
  it('an explicit environment value always wins', () => {
    expect(buildEngineEnv({ ARGUS_SKIP_OLLAMA: 'false' }, { withOllama: false }).ARGUS_SKIP_OLLAMA).toBe('false');
    expect(buildEngineEnv({ ARGUS_SKIP_OLLAMA: 'true' }, { withOllama: true }).ARGUS_SKIP_OLLAMA).toBe('true');
  });
  it('always marks the process as the headless engine and keeps the caller env', () => {
    const env = buildEngineEnv({ FOO: 'bar' }, { withOllama: false });
    expect(env).toMatchObject({ ARGUS_HEADLESS: 'true', ARGUS_ENGINE: 'true', FOO: 'bar' });
  });
});

describe('reconciliationIsClean (missing data is never clean)', () => {
  it('clean only when broker READY and the latest cycle has no mismatches', () => {
    expect(reconciliationIsClean(clean)).toBe(true);
  });
  it('rejects the post-boot ACCOUNT_VALUATION blip', () => {
    expect(reconciliationIsClean(blip)).toBe(false);
  });
  it('rejects a broker that is not READY, a missing cycle, an error payload and null', () => {
    expect(reconciliationIsClean({ ...clean, broker: { syncState: 'SYNCING' } })).toBe(false);
    expect(reconciliationIsClean({ tradingState: 'TRADING_PAUSED', broker: { syncState: 'READY' }, latest: null })).toBe(false);
    expect(reconciliationIsClean({ error: 'boom' })).toBe(false);
    expect(reconciliationIsClean(null)).toBe(false);
  });
});

describe('waitForCleanReconciliation', () => {
  function harness(responses: Array<ReconciliationSnapshot | Error>) {
    let t = 0;
    let i = 0;
    const calls: number[] = [];
    return {
      calls,
      deps: {
        now: () => t,
        sleep: async (ms: number) => { t += ms; },
        fetchStatus: async () => {
          calls.push(t);
          const r = responses[Math.min(i++, responses.length - 1)];
          if (r instanceof Error) throw r;
          return r;
        },
      },
    };
  }

  it('returns immediately when already clean', async () => {
    const h = harness([clean]);
    await expect(waitForCleanReconciliation(h.deps, { timeoutMs: 60_000, pollMs: 1000 })).resolves.toEqual({ clean: true, waitedMs: 0 });
  });

  it('waits through the transient post-boot blip and resumes only once it clears', async () => {
    const h = harness([blip, blip, clean]);
    const r = await waitForCleanReconciliation(h.deps, { timeoutMs: 60_000, pollMs: 5_000 });
    expect(r).toEqual({ clean: true, waitedMs: 10_000 });
    expect(h.calls).toEqual([0, 5_000, 10_000]);
  });

  it('never reports clean when the mismatch persists past the deadline', async () => {
    const h = harness([blip]);
    const r = await waitForCleanReconciliation(h.deps, { timeoutMs: 20_000, pollMs: 5_000 });
    expect(r).toMatchObject({ clean: false, lastSeen: 'MISMATCH' });
  });

  it('treats fetch errors as unavailable, never as clean', async () => {
    const h = harness([new Error('ECONNREFUSED')]);
    const r = await waitForCleanReconciliation(h.deps, { timeoutMs: 10_000, pollMs: 5_000 });
    expect(r).toMatchObject({ clean: false, lastSeen: 'UNAVAILABLE' });
  });

  it('recovers from a transient fetch error', async () => {
    const h = harness([new Error('ECONNREFUSED'), clean]);
    const r = await waitForCleanReconciliation(h.deps, { timeoutMs: 60_000, pollMs: 5_000 });
    expect(r.clean).toBe(true);
  });
});

describe('shouldRestoreTrading (a restart never undoes a deliberate pause)', () => {
  it('restores only a genuinely enabled, non-emergency state', () => {
    expect(shouldRestoreTrading({ tradingState: 'TRADING_ENABLED', emergencyStopActive: false })).toBe(true);
    expect(shouldRestoreTrading({ tradingState: 'TRADING_ENABLED' })).toBe(true);
  });
  it('does not restore a paused engine, an emergency stop, or an unknown state', () => {
    expect(shouldRestoreTrading({ tradingState: 'TRADING_PAUSED' })).toBe(false);
    expect(shouldRestoreTrading({ tradingState: 'EMERGENCY_STOP' })).toBe(false);
    expect(shouldRestoreTrading({ tradingState: 'TRADING_ENABLED', emergencyStopActive: true })).toBe(false);
    expect(shouldRestoreTrading({})).toBe(false);
  });
});
