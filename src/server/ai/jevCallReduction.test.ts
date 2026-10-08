/**
 * Phase 52 — Jev call-reduction measurement (AICallGovernor).
 *
 * === SYNTHETIC_SEEDED / NON_ORGANIC ===
 *
 * Against the REAL AICallGovernor contract (sibling landed 2026-10-07). The fake Jev is
 * injected via the governor's own test hook (__setJevProviderForTests); no network, no
 * secrets. The governor singleton is reset before/after every test so budgets, cooldowns,
 * cache, and circuits never leak between measurements.
 *
 * Real-contract notes the measurements depend on:
 *  - fingerprint = f(capability, kind, model, schemaVersion, symbol, fingerprintParts:Record)
 *    -> identical canonical keys hit CACHE_HIT after the first CALLED (check order #5);
 *  - NOT_MATERIAL (#4): kind news_catalyst_triage needs materiality >= MEDIUM, so LOW is skipped;
 *  - circuit opens after 5 consecutive tripping-kind failures (jevConsecutiveFailureThreshold);
 *  - SYMBOL_COOLDOWN is 5 minutes: distinct symbols are used where independent calls matter;
 *  - provider budgets (20/min jev) bound bursts; the circuit opens first in the outage test.
 *
 * Measures that the governor collapses a representative synthetic workload into a bounded
 * number of real provider invocations:
 *   1. 100 identical candidate events  -> ~1 provider invocation (dedupe + cache), never 100.
 *   2. 100 non-material symbols        -> 0 provider invocations (materiality gate).
 *   3. 20 duplicated articles, same event -> 1 canonical evaluation.
 *   4. provider down + 1000 events     -> bounded invocations, circuit opens, and the
 *      generative-executor `run` hook is never invoked (no automatic failover, ever).
 *
 * Every number is BOTH printed (console) and asserted. Assertions use generous upper
 * bounds (<=3, <=2, <=8) rather than exact equality so legitimate config/timing variance
 * doesn't false-fail; the printed exact numbers are the measurement record.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { AICallGovernor } from './AICallGovernor';
import { JevError } from './JevDecisionProvider';

describe('Jev call-reduction measurement (SYNTHETIC_SEEDED)', () => {
  let governor: any;
  let providerInvocations: number;
  let generativeFallbackCalls: number;

  function injectFake(behavior: 'healthy' | 'down') {
    providerInvocations = 0;
    generativeFallbackCalls = 0;
    governor.__setJevProviderForTests({
      isConfigured: () => true,
      decide: async () => {
        providerInvocations++;
        if (behavior === 'down') {
          throw new JevError('OVERLOAD', 'synthetic Jev overload (SYNTHETIC_SEEDED)');
        }
        return {
          answers: { relevant: 0.9, materiality: 4, classification: 'SYNTHETIC_CATALYST' },
          model: 'jev-synthetic',
          inputTokens: 10,
          latencyMs: 1,
        };
      },
    });
  }

  function candidate(
    materiality: 'HIGH' | 'MEDIUM' | 'LOW',
    fingerprintParts: Record<string, string | number | boolean | null | undefined>,
    symbol: string,
    i: number | string,
  ) {
    return {
      capability: 'STRUCTURED_DECISION' as const,
      kind: 'news_catalyst_triage',
      material: {
        symbol,
        fingerprintParts,
        materiality,
        decisionDeadlineMs: Date.now() + 60_000,
        traceId: `synthetic-callred-${i}`,
      },
      jev: {
        state: { synthetic: true },
        questions: { material: 'is this catalyst material?' },
        schemaVersion: '1',
      },
      // Required by the type. For STRUCTURED_DECISION the governor builds the Jev call
      // itself; this hook is the generative executor and must stay silent throughout
      // these measurements (no automatic failover, ever).
      run: async () => {
        generativeFallbackCalls++;
        return { value: null, cacheable: false };
      },
    };
  }

  beforeAll(() => {
    governor = AICallGovernor.getInstance();
  });

  beforeEach(() => {
    governor.resetForTests();
  });

  afterEach(() => {
    governor.resetForTests();
  });

  afterAll(() => {
    governor.resetForTests();
  });

  it('100 identical candidate events -> ~1 provider invocation (not 100)', async () => {
    injectFake('healthy');
    const statuses: string[] = [];
    for (let i = 0; i < 100; i++) {
      const res = await governor.request(candidate('HIGH', { event: 'synthetic-event-7', symbol: 'AAPL' }, 'AAPL', i));
      statuses.push(res.status);
    }
    const diag = governor.getDiagnostics();
    console.log(
      `[call-reduction] 100 identical candidates -> ${providerInvocations} provider invocations ` +
      `(statuses: ${[...new Set(statuses)].join(',')}, cacheHits: ${diag.cacheHits}, ` +
      `generative fallback calls: ${generativeFallbackCalls})`,
    );
    expect(providerInvocations).toBeLessThanOrEqual(3);
    expect(providerInvocations).toBeGreaterThanOrEqual(1);
    expect(providerInvocations).toBeLessThan(100);
    expect(generativeFallbackCalls).toBe(0);
  }, 60000);

  it('100 non-material symbols -> 0 provider invocations', async () => {
    injectFake('healthy');
    for (let i = 0; i < 100; i++) {
      // news_catalyst_triage requires materiality >= MEDIUM: LOW is NOT_MATERIAL by policy.
      const res = await governor.request(candidate('LOW', { event: `non-material-${i}` }, `SYM${i}`, i));
      expect(res.status).toBe('SKIPPED');
      expect((res as any).reason).toBe('NOT_MATERIAL');
    }
    console.log(`[call-reduction] 100 non-material symbols -> ${providerInvocations} provider invocations`);
    expect(providerInvocations).toBe(0);
    expect(generativeFallbackCalls).toBe(0);
  }, 60000);

  it('20 duplicated articles for the same event -> 1 canonical evaluation', async () => {
    injectFake('healthy');
    for (let i = 0; i < 20; i++) {
      // Same canonical event (identical kind + fingerprintParts => identical fingerprint);
      // only the article wrapper (traceId) differs.
      const res = await governor.request(
        candidate('HIGH', { event: 'synthetic-event-9', symbol: 'NVDA' }, 'NVDA', `article-${i}`),
      );
      expect(['CALLED', 'CACHE_HIT']).toContain(res.status);
    }
    console.log(`[call-reduction] 20 duplicated articles, same event -> ${providerInvocations} provider invocations`);
    expect(providerInvocations).toBeLessThanOrEqual(2);
    expect(generativeFallbackCalls).toBe(0);
  }, 60000);

  it('provider down + 1000 events -> bounded invocations, circuit opens, no generative fallback', async () => {
    injectFake('down');
    const statuses: string[] = [];
    const reasons: string[] = [];
    // Distinct symbols: per-symbol cooldown (5 min) must not mask the circuit behavior.
    for (let i = 0; i < 1000; i++) {
      const res = await governor.request(candidate('HIGH', { event: 'outage', i }, `OUT${i}`, i));
      statuses.push(res.status);
      if (res.status === 'SKIPPED') reasons.push((res as any).reason);
    }
    const tail = statuses.slice(-100);
    const diag = governor.getDiagnostics();
    console.log(
      `[call-reduction] provider down + 1000 events -> ${providerInvocations} provider invocations, ` +
      `circuit: ${diag.circuits.jev}, failures: ${diag.failures}, ` +
      `generative fallback calls: ${generativeFallbackCalls}, ` +
      `tail-100 statuses: ${[...new Set(tail)].join(',')} (reasons: ${[...new Set(reasons)].join(',')})`,
    );
    // Bounded: the circuit trips after 5 consecutive failures (jevConsecutiveFailureThreshold),
    // not after 1000 provider calls.
    expect(providerInvocations).toBeLessThanOrEqual(8);
    expect(diag.circuits.jev).toBe('OPEN');
    // The outage tail is all CIRCUIT_OPEN skips — no provider touch, no fallback.
    expect(tail.every((s) => s === 'SKIPPED')).toBe(true);
    expect(reasons).toContain('CIRCUIT_OPEN');
    // The generative executor must not be used as a silent fallback around the open circuit.
    expect(generativeFallbackCalls).toBe(0);
  }, 120000);
});
