/**
 * AICallGovernor.test.ts - behavior proof for the central optional-AI gate.
 *
 * Conventions (repo hard rules): expected values are read from the same config
 * loader production uses (src/server/config/aiCallGovernor.ts), not literals.
 * No real network, no LLM calls: the Jev provider is injected via
 * __setJevProviderForTests(), the generative path via setGenerativeExecutor().
 * Time is injected via __setClockForTests() (no real waiting for cooldowns /
 * budgets / circuit cooldowns). The one exception is the timeout test, which
 * uses vitest fake timers to fire the governor's real setTimeout race.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AICallGovernor,
  type AiCallMaterial,
  type GovernorRequestOpts,
  type JevProviderHandle,
} from './AICallGovernor';
import type { JevDecisionResult } from './JevDecisionProvider';
import { aiCallGovernor } from '../config/aiCallGovernor';
import { structuredLogger } from '../observability/StructuredLogger';

const gov = AICallGovernor.getInstance();

let now = 1_700_000_000_000;
const advance = (ms: number): void => {
  now += ms;
};

beforeEach(() => {
  now = 1_700_000_000_000;
  gov.resetForTests();
  gov.__setClockForTests(() => now);
  delete process.env.ARGUS_AI_CALL_GOVERNOR_ENABLED;
  delete process.env.ARGUS_JEV_ENABLED;
});

afterEach(() => {
  delete process.env.ARGUS_AI_CALL_GOVERNOR_ENABLED;
  delete process.env.ARGUS_JEV_ENABLED;
  vi.restoreAllMocks();
});

// -- factories ---------------------------------------------------------------

function material(over: Partial<AiCallMaterial> = {}): AiCallMaterial {
  return {
    fingerprintParts: { event: 'evt-1' },
    materiality: 'MEDIUM',
    decisionDeadlineMs: now + 3_600_000,
    ...over,
  };
}

function genOpts(
  over: Partial<GovernorRequestOpts<string>> = {},
  run?: GovernorRequestOpts<string>['run'],
): GovernorRequestOpts<string> {
  return {
    capability: 'GENERATIVE_ANALYSIS',
    kind: 'news_catalyst_triage',
    material: material(),
    run: run ?? (async () => ({ value: 'ok', cacheable: false })),
    ...over,
  };
}

function jevOpts(
  over: Partial<GovernorRequestOpts<unknown>> = {},
): GovernorRequestOpts<unknown> {
  return {
    capability: 'STRUCTURED_DECISION',
    kind: 'news_catalyst_triage',
    material: material(),
    run: async () => {
      throw new Error('run must never be used for STRUCTURED_DECISION');
    },
    jev: {
      state: { symbol: 'AAPL', headline: 'earnings beat' },
      questions: { bullish: { type: 'noul', instructions: 'is this bullish?' } },
      schemaVersion: 'test-v1',
    },
    ...over,
  };
}

function jevFailer(kind: string): { provider: JevProviderHandle; decide: ReturnType<typeof vi.fn> } {
  const decide = vi.fn(async () => {
    const err = new Error(`jev ${kind}`) as Error & { kind: string };
    err.kind = kind;
    throw err;
  });
  return {
    provider: {
      isConfigured: () => true,
      decide: decide as unknown as JevProviderHandle['decide'],
    },
    decide,
  };
}

function jevSucceed(
  answer: unknown = { bullish: 0.8 },
): { provider: JevProviderHandle; decide: ReturnType<typeof vi.fn> } {
  const decide = vi.fn(async () => ({
    answers: answer as JevDecisionResult['answers'],
    model: 'jev-1.13.0',
    inputTokens: 42,
    latencyMs: 5,
  }));
  return {
    provider: {
      isConfigured: () => true,
      decide: decide as unknown as JevProviderHandle['decide'],
    },
    decide,
  };
}

// -- DISABLED ----------------------------------------------------------------

describe('DISABLED', () => {
  it('master switch off -> SKIPPED/DISABLED, zero provider invocations', async () => {
    process.env.ARGUS_AI_CALL_GOVERNOR_ENABLED = 'false';
    const run = vi.fn(async () => ({ value: 'x', cacheable: false }));
    gov.setGenerativeExecutor(run);
    const res = await gov.request(genOpts({}, run));
    expect(res.status).toBe('SKIPPED');
    if (res.status === 'SKIPPED') expect(res.reason).toBe('DISABLED');
    expect(run).not.toHaveBeenCalled();
    expect(gov.getDiagnostics().skips['DISABLED']).toBe(1);
    expect(gov.getDiagnostics().called).toBe(0);
  });

  it('jev capability off -> STRUCTURED_DECISION DISABLED but GENERATIVE_ANALYSIS still governed', async () => {
    process.env.ARGUS_JEV_ENABLED = 'false';
    gov.__setJevProviderForTests(jevSucceed().provider);
    const structured = await gov.request(jevOpts());
    expect(structured.status).toBe('SKIPPED');
    if (structured.status === 'SKIPPED') expect(structured.reason).toBe('DISABLED');

    const run = vi.fn(async () => ({ value: 'g', cacheable: false }));
    gov.setGenerativeExecutor(run);
    const gen = await gov.request(genOpts({ material: material({ symbol: 'GEN1' }) }, run));
    expect(gen.status).toBe('CALLED');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// -- deadlines ----------------------------------------------------------------

describe('deadlines', () => {
  it('STALE_EVENT when decisionDeadlineMs already passed', async () => {
    const run = vi.fn(async () => ({ value: 'x', cacheable: false }));
    gov.setGenerativeExecutor(run);
    const res = await gov.request(
      genOpts({ material: material({ decisionDeadlineMs: now - 1 }) }, run),
    );
    expect(res.status).toBe('SKIPPED');
    if (res.status === 'SKIPPED') expect(res.reason).toBe('STALE_EVENT');
    expect(run).not.toHaveBeenCalled();
  });

  it('DEADLINE_TOO_CLOSE when remaining lead < aiDecisionDeadlineMinLeadMs from config', async () => {
    const lead = aiCallGovernor.aiDecisionDeadlineMinLeadMs;
    expect(lead).toBeGreaterThan(0);
    const run = vi.fn(async () => ({ value: 'x', cacheable: false }));
    gov.setGenerativeExecutor(run);
    const tooClose = await gov.request(
      genOpts({ material: material({ decisionDeadlineMs: now + lead - 1 }) }, run),
    );
    expect(tooClose.status).toBe('SKIPPED');
    if (tooClose.status === 'SKIPPED') expect(tooClose.reason).toBe('DEADLINE_TOO_CLOSE');

    // Exactly the minimum lead is acceptable.
    const ok = await gov.request(
      genOpts(
        { material: material({ decisionDeadlineMs: now + lead, symbol: 'DL2' }) },
        run,
      ),
    );
    expect(ok.status).toBe('CALLED');
  });
});

// -- materiality ----------------------------------------------------------------

describe('NOT_MATERIAL', () => {
  it('LOW materiality rejected for a MEDIUM-minimum kind', async () => {
    const run = vi.fn(async () => ({ value: 'x', cacheable: false }));
    gov.setGenerativeExecutor(run);
    const res = await gov.request(
      genOpts({ material: material({ materiality: 'LOW' }) }, run),
    );
    expect(res.status).toBe('SKIPPED');
    if (res.status === 'SKIPPED') expect(res.reason).toBe('NOT_MATERIAL');
    expect(run).not.toHaveBeenCalled();
  });

  it('LOW materiality explicitly allowed for post_trade_research; HIGH required for regime_change', async () => {
    const run = vi.fn(async () => ({ value: 'x', cacheable: false }));
    gov.setGenerativeExecutor(run);
    const research = await gov.request(
      genOpts(
        { kind: 'post_trade_research', material: material({ materiality: 'LOW', symbol: 'R1' }) },
        run,
      ),
    );
    expect(research.status).toBe('CALLED');

    const regimeLow = await gov.request(
      genOpts(
        { kind: 'regime_change', material: material({ materiality: 'MEDIUM', symbol: 'R2' }) },
        run,
      ),
    );
    expect(regimeLow.status).toBe('SKIPPED');
    if (regimeLow.status === 'SKIPPED') expect(regimeLow.reason).toBe('NOT_MATERIAL');
  });

  it('unknown kinds default to MEDIUM minimum (fail closed)', async () => {
    const run = vi.fn(async () => ({ value: 'x', cacheable: false }));
    gov.setGenerativeExecutor(run);
    const res = await gov.request(
      genOpts({ kind: 'some_future_kind', material: material({ materiality: 'LOW' }) }, run),
    );
    expect(res.status).toBe('SKIPPED');
    if (res.status === 'SKIPPED') expect(res.reason).toBe('NOT_MATERIAL');
  });
});

// -- cache --------------------------------------------------------------------

describe('cache', () => {
  it('CACHE_HIT returns the cached value without calling run again', async () => {
    const run = vi.fn(async () => ({ value: 'cached-value', cacheable: true }));
    gov.setGenerativeExecutor(run);
    const first = await gov.request(genOpts({}, run));
    expect(first.status).toBe('CALLED');
    const second = await gov.request(genOpts({}, run));
    expect(second.status).toBe('CACHE_HIT');
    if (second.status === 'CACHE_HIT') expect(second.result).toBe('cached-value');
    expect(run).toHaveBeenCalledTimes(1);
    expect(gov.getDiagnostics().cacheHits).toBe(1);
  });

  it('fingerprint is stable across key order and excludes traceId/wall-clock', async () => {
    const run = vi.fn(async () => ({ value: 'v', cacheable: true }));
    gov.setGenerativeExecutor(run);
    await gov.request(
      genOpts(
        {
          material: material({
            fingerprintParts: { b: 2, a: 1, flag: true },
            traceId: 'trace-one',
          }),
        },
        run,
      ),
    );
    // Same content, shuffled keys, different traceId -> identical fingerprint.
    const hit = await gov.request(
      genOpts(
        {
          material: material({
            fingerprintParts: { flag: true, a: 1, b: 2 },
            traceId: 'trace-two',
          }),
        },
        run,
      ),
    );
    expect(hit.status).toBe('CACHE_HIT');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cache entry expires after the kind TTL from config', async () => {
    const ttl = aiCallGovernor.cacheTtlMsByKind['quant_candidate_advisory'];
    expect(ttl).toBeGreaterThan(0);
    const run = vi.fn(async () => ({ value: 'v', cacheable: true }));
    gov.setGenerativeExecutor(run);
    const opts = genOpts({ kind: 'quant_candidate_advisory' }, run);
    expect((await gov.request(opts)).status).toBe('CALLED');
    expect((await gov.request(opts)).status).toBe('CACHE_HIT');
    advance(ttl + 1);
    expect((await gov.request(opts)).status).toBe('CALLED');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('non-cacheable results are never cached', async () => {
    const run = vi.fn(async () => ({ value: 'v', cacheable: false }));
    gov.setGenerativeExecutor(run);
    expect((await gov.request(genOpts({}, run))).status).toBe('CALLED');
    expect((await gov.request(genOpts({}, run))).status).toBe('CALLED');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('LRU eviction keeps the cache bounded at aiStateCacheMaxEntries from config', async () => {
    const max = aiCallGovernor.aiStateCacheMaxEntries;
    const run = vi.fn(async () => ({ value: 'v', cacheable: true }));
    gov.setGenerativeExecutor(run);
    const fp0Parts = { n: 0 };
    for (let i = 0; i <= max; i++) {
      // Stay under the per-minute budgets (generative 10/min binds first).
      if (i > 0 && i % 10 === 0) advance(61_000);
      await gov.request(
        genOpts({ material: material({ symbol: `LRU${i}`, fingerprintParts: { n: i } }) }, run),
      );
    }
    expect(gov.getDiagnostics().cacheSize).toBeLessThanOrEqual(max);
    // Oldest entry (n=0) was evicted -> provider called again; newest still hits.
    // (Same symbols as the original inserts: the fingerprint includes the
    // symbol. Per-symbol cooldowns expired long ago via the clock advances.)
    const again0 = await gov.request(
      genOpts({ material: material({ symbol: 'LRU0', fingerprintParts: fp0Parts }) }, run),
    );
    expect(again0.status).toBe('CALLED');
    const againMax = await gov.request(
      genOpts({ material: material({ symbol: `LRU${max}`, fingerprintParts: { n: max } }) }, run),
    );
    expect(againMax.status).toBe('CACHE_HIT');
  });

  it('600+ cacheable inserts stay bounded at aiStateCacheMaxEntries from config', async () => {
    const max = aiCallGovernor.aiStateCacheMaxEntries;
    const inserts = max + 100; // deliberately over the cap, whatever config sets it to
    const run = vi.fn(async () => ({ value: 'v', cacheable: true }));
    gov.setGenerativeExecutor(run);
    for (let i = 0; i < inserts; i++) {
      // Stay under the per-minute budgets (generative 10/min binds first).
      if (i > 0 && i % 10 === 0) advance(61_000);
      const res = await gov.request(
        genOpts({ material: material({ fingerprintParts: { n: i } }) }, run),
      );
      expect(res.status).toBe('CALLED');
    }
    expect(run).toHaveBeenCalledTimes(inserts);
    expect(gov.getDiagnostics().cacheSize).toBeLessThanOrEqual(max);
  });
});

// -- singleflight ----------------------------------------------------------------

describe('singleflight', () => {
  it('20 concurrent identical requests -> exactly 1 provider run, 19 joins', async () => {
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { value: 'shared', cacheable: false };
    });
    gov.setGenerativeExecutor(run);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => gov.request(genOpts({}, run))),
    );
    expect(run).toHaveBeenCalledTimes(1);
    for (const res of results) {
      expect(res.status).toBe('CALLED');
      if (res.status === 'CALLED') expect(res.result).toBe('shared');
    }
    const d = gov.getDiagnostics();
    expect(d.singleflightJoins).toBe(19);
    expect(d.skips['DUPLICATE']).toBe(19);
    expect(d.called).toBe(1);
  });

  it('provider failure cycles never leave entries in the in-flight map', async () => {
    const { provider, decide } = jevFailer('TIMEOUT');
    gov.__setJevProviderForTests(provider);
    for (let i = 0; i < 8; i++) {
      const res = await gov.request(
        jevOpts({ material: material({ fingerprintParts: { n: i } }) }),
      );
      // The first failures go through the provider (FAILED); once the circuit
      // opens the rest skip at CIRCUIT_OPEN. Either way nothing may remain
      // in-flight after the request settles.
      expect(['FAILED', 'SKIPPED']).toContain(res.status);
      expect(gov.getDiagnostics().inFlight).toBe(0);
    }
    expect(decide).toHaveBeenCalled();
  });
});

// -- cooldowns -------------------------------------------------------------------

describe('SYMBOL_COOLDOWN', () => {
  it('second call for the same symbol within aiPerSymbolCooldownMs is skipped', async () => {
    expect(aiCallGovernor.aiPerSymbolCooldownMs).toBeGreaterThan(0);
    const run = vi.fn(async () => ({ value: 'v', cacheable: false }));
    gov.setGenerativeExecutor(run);
    const first = await gov.request(
      genOpts({ material: material({ symbol: 'AAPL', fingerprintParts: { n: 1 } }) }, run),
    );
    expect(first.status).toBe('CALLED');
    const second = await gov.request(
      genOpts({ material: material({ symbol: 'AAPL', fingerprintParts: { n: 2 } }) }, run),
    );
    expect(second.status).toBe('SKIPPED');
    if (second.status === 'SKIPPED') expect(second.reason).toBe('SYMBOL_COOLDOWN');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cooldown expires after aiPerSymbolCooldownMs; per-symbol budget never false-trips', async () => {
    const run = vi.fn(async () => ({ value: 'v', cacheable: false }));
    gov.setGenerativeExecutor(run);
    for (let i = 0; i < 4; i++) {
      if (i > 0) advance(aiCallGovernor.aiPerSymbolCooldownMs + 1);
      const res = await gov.request(
        genOpts({ material: material({ symbol: 'MSFT', fingerprintParts: { n: i } }) }, run),
      );
      expect(res.status).toBe('CALLED');
    }
    expect(run).toHaveBeenCalledTimes(4);
    // Documented interplay: with the shipped config the per-symbol cooldown
    // (5 min) dominates the per-symbol per-minute budget, which therefore acts
    // as defense-in-depth for tighter cooldown configs rather than firing here.
    expect(gov.getDiagnostics().skips['PROVIDER_BUDGET'] ?? 0).toBe(0);
  });

  it('churning 2500 unique symbols keeps per-symbol maps bounded', async () => {
    // MAX_SYMBOL_BUCKETS (module constant) caps both maps at 2000; the cooldown
    // map is additionally TTL-pruned on every symbol request. Non-cacheable so
    // the cache does not grow alongside.
    const run = vi.fn(async () => ({ value: 'v', cacheable: false }));
    gov.setGenerativeExecutor(run);
    for (let i = 0; i < 2500; i++) {
      // Stay under the per-minute budgets (generative 10/min binds first, then
      // the 30/min global); clock advances also let the cooldown TTL prune
      // stale entries, as in production.
      if (i > 0 && i % 10 === 0) advance(61_000);
      const res = await gov.request(
        genOpts({ material: material({ symbol: `CHURN${i}`, fingerprintParts: { n: i } }) }, run),
      );
      expect(res.status).toBe('CALLED');
    }
    const d = gov.getDiagnostics();
    expect(d.symbolWindows).toBeLessThanOrEqual(2000);
    expect(d.symbolCooldowns).toBeLessThanOrEqual(2000);
  }, 120_000);
});

// -- budgets ----------------------------------------------------------------------

describe('budgets', () => {
  it('GLOBAL_BUDGET fires when the combined per-minute volume hits aiGlobalOptionalCallsPerMinute', async () => {
    // Budgets nest: the global budget (30/min from config) caps the SUM across
    // capabilities, so it binds only once jev (20/min) + generative (10/min)
    // together reach 30. Check order puts GLOBAL_BUDGET before PROVIDER_BUDGET.
    const { provider, decide } = jevSucceed();
    gov.__setJevProviderForTests(provider);
    const run = vi.fn(async () => ({ value: 'v', cacheable: false }));
    gov.setGenerativeExecutor(run);
    for (let i = 0; i < aiCallGovernor.jevCallsPerMinute; i++) {
      const res = await gov.request(
        jevOpts({ material: material({ symbol: `J${i}`, fingerprintParts: { n: i } }) }),
      );
      expect(res.status).toBe('CALLED');
    }
    for (let i = 0; i < aiCallGovernor.generativeCallsPerMinute; i++) {
      const res = await gov.request(
        genOpts({ material: material({ symbol: `P${i}`, fingerprintParts: { n: i } }) }, run),
      );
      expect(res.status).toBe('CALLED');
    }
    expect(decide).toHaveBeenCalledTimes(aiCallGovernor.jevCallsPerMinute);
    expect(run).toHaveBeenCalledTimes(aiCallGovernor.generativeCallsPerMinute);

    const over = await gov.request(
      genOpts(
        {
          material: material({
            symbol: 'G-over',
            fingerprintParts: { n: aiCallGovernor.aiGlobalOptionalCallsPerMinute },
          }),
        },
        run,
      ),
    );
    expect(over.status).toBe('SKIPPED');
    if (over.status === 'SKIPPED') expect(over.reason).toBe('GLOBAL_BUDGET');
    expect(run).toHaveBeenCalledTimes(aiCallGovernor.generativeCallsPerMinute);
    // Sliding window: after a minute the budget refills.
    advance(61_000);
    const refilled = await gov.request(
      genOpts(
        {
          material: material({
            symbol: 'G-refill',
            fingerprintParts: { n: aiCallGovernor.aiGlobalOptionalCallsPerMinute + 1 },
          }),
        },
        run,
      ),
    );
    expect(refilled.status).toBe('CALLED');
  });

  it('PROVIDER_BUDGET fires after generativeCallsPerMinute generative calls', async () => {
    const limit = aiCallGovernor.generativeCallsPerMinute;
    const run = vi.fn(async () => ({ value: 'v', cacheable: false }));
    gov.setGenerativeExecutor(run);
    for (let i = 0; i < limit; i++) {
      const res = await gov.request(
        genOpts({ material: material({ symbol: `P${i}`, fingerprintParts: { n: i } }) }, run),
      );
      expect(res.status).toBe('CALLED');
    }
    const over = await gov.request(
      genOpts({ material: material({ symbol: 'P-over', fingerprintParts: { n: limit } }) }, run),
    );
    expect(over.status).toBe('SKIPPED');
    if (over.status === 'SKIPPED') expect(over.reason).toBe('PROVIDER_BUDGET');
    expect(run).toHaveBeenCalledTimes(limit);
  });
});

// -- provider health ----------------------------------------------------------------

describe('provider health', () => {
  it('STRUCTURED_DECISION with no Jev provider -> SKIPPED/NO_API_KEY, run never used', async () => {
    gov.__setJevProviderForTests(null); // force "module absent / not configured"
    const run = vi.fn(async () => ({ value: 'x', cacheable: false }));
    const res = await gov.request(jevOpts({ run }));
    expect(res.status).toBe('SKIPPED');
    if (res.status === 'SKIPPED') expect(res.reason).toBe('NO_API_KEY');
    expect(run).not.toHaveBeenCalled();
  });

  it('isConfigured()=false -> SKIPPED/NO_API_KEY', async () => {
    gov.__setJevProviderForTests({ isConfigured: () => false, decide: vi.fn() });
    const res = await gov.request(jevOpts());
    expect(res.status).toBe('SKIPPED');
    if (res.status === 'SKIPPED') expect(res.reason).toBe('NO_API_KEY');
  });

  it('GENERATIVE_ANALYSIS with no executor -> SKIPPED/PROVIDER_UNHEALTHY', async () => {
    const run = vi.fn(async () => ({ value: 'x', cacheable: false }));
    const res = await gov.request(genOpts({}, run));
    expect(res.status).toBe('SKIPPED');
    if (res.status === 'SKIPPED') expect(res.reason).toBe('PROVIDER_UNHEALTHY');
    expect(run).not.toHaveBeenCalled();
  });

  it('Jev success path never invokes opts.run (governor builds the Jev request itself)', async () => {
    const { provider, decide } = jevSucceed({ bullish: 0.9 });
    gov.__setJevProviderForTests(provider);
    const run = vi.fn(async () => ({ value: 'x', cacheable: false }));
    const res = await gov.request(jevOpts({ run }));
    expect(res.status).toBe('CALLED');
    if (res.status === 'CALLED') {
      expect(res.result).toEqual({ answers: { bullish: 0.9 }, model: 'jev-1.13.0', inputTokens: 42, latencyMs: 5 });
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(run).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledTimes(1);
    const decideArg = decide.mock.calls[0][0];
    expect(decideArg.model).toBe(aiCallGovernor.jevModel);
    expect(decideArg.schemaVersion).toBe('test-v1');
    expect(decideArg.timeoutMs).toBe(aiCallGovernor.jevTimeoutMs);
  });

  it('AUTH failure does NOT trip the breaker; provider marked unhealthy -> later NO_API_KEY', async () => {
    const { provider, decide } = jevFailer('AUTH');
    gov.__setJevProviderForTests(provider);
    const first = await gov.request(jevOpts());
    expect(first.status).toBe('FAILED');
    if (first.status === 'FAILED') expect(first.kind).toBe('AUTH');
    expect(gov.getDiagnostics().circuits['jev']).toBe('CLOSED');

    const second = await gov.request(
      jevOpts({ material: material({ symbol: 'AUTH2', fingerprintParts: { n: 2 } }) }),
    );
    expect(second.status).toBe('SKIPPED');
    if (second.status === 'SKIPPED') expect(second.reason).toBe('NO_API_KEY');
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('STRUCTURED_DECISION without opts.jev -> FAILED/VALIDATION, breaker stays CLOSED', async () => {
    gov.__setJevProviderForTests(jevSucceed().provider);
    const res = await gov.request({
      capability: 'STRUCTURED_DECISION',
      kind: 'news_catalyst_triage',
      material: material(),
      run: async () => ({ value: 'x', cacheable: false }),
    });
    expect(res.status).toBe('FAILED');
    if (res.status === 'FAILED') expect(res.kind).toBe('VALIDATION');
    expect(gov.getDiagnostics().circuits['jev']).toBe('CLOSED');
  });
});

// -- circuit breaker ------------------------------------------------------------------

describe('circuit breaker', () => {
  it('opens after jevConsecutiveFailureThreshold consecutive failures, then skips CIRCUIT_OPEN', async () => {
    const threshold = aiCallGovernor.jevConsecutiveFailureThreshold;
    const { provider, decide } = jevFailer('SERVER');
    gov.__setJevProviderForTests(provider);
    for (let i = 0; i < threshold; i++) {
      const res = await gov.request(
        jevOpts({ material: material({ symbol: `CB${i}`, fingerprintParts: { n: i } }) }),
      );
      expect(res.status).toBe('FAILED');
    }
    expect(gov.getDiagnostics().circuits['jev']).toBe('OPEN');
    const skipped = await gov.request(
      jevOpts({ material: material({ symbol: 'CB-skip', fingerprintParts: { n: threshold } }) }),
    );
    expect(skipped.status).toBe('SKIPPED');
    if (skipped.status === 'SKIPPED') expect(skipped.reason).toBe('CIRCUIT_OPEN');
    expect(decide).toHaveBeenCalledTimes(threshold);
  });

  it('HALF_OPEN after cooldown: successful probe recovers the circuit to CLOSED', async () => {
    const { provider } = jevFailer('NETWORK');
    gov.__setJevProviderForTests(provider);
    const threshold = aiCallGovernor.jevConsecutiveFailureThreshold;
    for (let i = 0; i < threshold; i++) {
      await gov.request(
        jevOpts({ material: material({ symbol: `RC${i}`, fingerprintParts: { n: i } }) }),
      );
    }
    expect(gov.getDiagnostics().circuits['jev']).toBe('OPEN');

    advance(aiCallGovernor.jevCircuitOpenCooldownMs + 1);
    const { provider: healthyProvider, decide: healthyDecide } = jevSucceed();
    gov.__setJevProviderForTests(healthyProvider);
    const probe = await gov.request(
      jevOpts({ material: material({ symbol: 'RC-probe', fingerprintParts: { n: 99 } }) }),
    );
    expect(probe.status).toBe('CALLED');
    expect(gov.getDiagnostics().circuits['jev']).toBe('CLOSED');

    const after = await gov.request(
      jevOpts({ material: material({ symbol: 'RC-after', fingerprintParts: { n: 100 } }) }),
    );
    expect(after.status).toBe('CALLED');
    expect(healthyDecide).toHaveBeenCalledTimes(2);
  });

  it('HALF_OPEN probe failure re-opens the circuit', async () => {
    const { provider } = jevFailer('OVERLOAD');
    gov.__setJevProviderForTests(provider);
    const threshold = aiCallGovernor.jevConsecutiveFailureThreshold;
    for (let i = 0; i < threshold; i++) {
      await gov.request(
        jevOpts({ material: material({ symbol: `PO${i}`, fingerprintParts: { n: i } }) }),
      );
    }
    advance(aiCallGovernor.jevCircuitOpenCooldownMs + 1);
    const probe = await gov.request(
      jevOpts({ material: material({ symbol: 'PO-probe', fingerprintParts: { n: 99 } }) }),
    );
    expect(probe.status).toBe('FAILED');
    expect(gov.getDiagnostics().circuits['jev']).toBe('OPEN');
  });

  it('HALF_OPEN probe budget (jevHalfOpenMaxProbes) bounds concurrent probes', async () => {
    const maxProbes = aiCallGovernor.jevHalfOpenMaxProbes;
    const resolvers: Array<(v: JevDecisionResult) => void> = [];
    const hangingDecide = vi.fn(
      () => new Promise<JevDecisionResult>((resolve) => resolvers.push(resolve)),
    );
    const provider: JevProviderHandle = {
      isConfigured: () => true,
      decide: hangingDecide as unknown as JevProviderHandle['decide'],
    };
    gov.__setJevProviderForTests(provider);
    // Open the circuit first with immediate failures.
    gov.__setJevProviderForTests(jevFailer('SERVER').provider);
    const threshold = aiCallGovernor.jevConsecutiveFailureThreshold;
    for (let i = 0; i < threshold; i++) {
      await gov.request(
        jevOpts({ material: material({ symbol: `PB${i}`, fingerprintParts: { n: i } }) }),
      );
    }
    gov.__setJevProviderForTests(provider);
    advance(aiCallGovernor.jevCircuitOpenCooldownMs + 1);

    const pending = Array.from({ length: maxProbes }, (_, i) =>
      gov.request(
        jevOpts({ material: material({ symbol: `PBp${i}`, fingerprintParts: { n: 100 + i } }) }),
      ),
    );
    // Give the probes a turn to register as half-open probes.
    await new Promise((r) => setTimeout(r, 10));
    const extra = await gov.request(
      jevOpts({ material: material({ symbol: 'PB-extra', fingerprintParts: { n: 999 } }) }),
    );
    expect(extra.status).toBe('SKIPPED');
    if (extra.status === 'SKIPPED') expect(extra.reason).toBe('CIRCUIT_OPEN');

    resolvers.forEach((r) =>
      r({ answers: {}, model: 'jev-1.13.0', inputTokens: 1, latencyMs: 1 }),
    );
    const results = await Promise.all(pending);
    expect(results.every((r) => r.status === 'CALLED')).toBe(true);
    expect(gov.getDiagnostics().circuits['jev']).toBe('CLOSED');
  });
});

// -- queue -------------------------------------------------------------------------

describe('QUEUE_FULL', () => {
  it('in-flight beyond jevMaxInFlight + jevQueueLimit -> SKIPPED/QUEUE_FULL, no unbounded queue', async () => {
    const capacity = aiCallGovernor.jevMaxInFlight + aiCallGovernor.jevQueueLimit;
    const resolvers: Array<(v: { value: unknown; cacheable: boolean }) => void> = [];
    gov.setGenerativeExecutor(
      () => new Promise<{ value: unknown; cacheable: boolean }>((resolve) => resolvers.push(resolve)),
    );
    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < capacity; i++) {
      // Refill the per-minute budgets (generative 10/min binds first) so the
      // only binding constraint is in-flight capacity.
      if (i > 0 && i % aiCallGovernor.generativeCallsPerMinute === 0) advance(61_000);
      pending.push(
        gov.request(
          genOpts({ material: material({ symbol: `Q${i}`, fingerprintParts: { n: i } }) }),
        ),
      );
    }
    await new Promise((r) => setTimeout(r, 10)); // let all register in-flight
    expect(gov.getDiagnostics().inFlight).toBe(capacity);

    const over = await gov.request(
      genOpts({ material: material({ symbol: 'Q-over', fingerprintParts: { n: capacity } }) }),
    );
    expect(over.status).toBe('SKIPPED');
    if (over.status === 'SKIPPED') expect(over.reason).toBe('QUEUE_FULL');

    resolvers.forEach((r) => r({ value: 'ok', cacheable: false }));
    const results = await Promise.all(pending);
    expect(results.filter((r) => (r as { status: string }).status === 'CALLED')).toHaveLength(
      capacity,
    );
    expect(gov.getDiagnostics().inFlight).toBe(0);
  });
});

// -- failure handling ------------------------------------------------------------------

describe('failure handling', () => {
  it('FAILED never throws to the caller; kind preserved from provider error', async () => {
    const boom = new Error('boom') as Error & { kind: string };
    boom.kind = 'RATE_LIMIT';
    const run = vi.fn(async () => {
      throw boom;
    });
    gov.setGenerativeExecutor(run);
    const res = await gov.request(genOpts({}, run));
    expect(res.status).toBe('FAILED');
    if (res.status === 'FAILED') {
      expect(res.kind).toBe('RATE_LIMIT');
      expect(res.error).toBe(boom);
    }
    const d = gov.getDiagnostics();
    expect(d.failures).toBe(1);
    expect(d.timeouts).toBe(0);
  });

  it('hanging provider call times out -> FAILED/TIMEOUT (fake timers fire the real race)', async () => {
    vi.useFakeTimers();
    try {
      gov.setGenerativeExecutor(() => new Promise<never>(() => {}));
      const p = gov.request(genOpts());
      await vi.advanceTimersByTimeAsync(aiCallGovernor.jevTimeoutMs);
      const res = await p;
      expect(res.status).toBe('FAILED');
      if (res.status === 'FAILED') expect(res.kind).toBe('TIMEOUT');
      expect(gov.getDiagnostics().timeouts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// -- no failover, ever --------------------------------------------------------------------

describe('no automatic failover between capabilities', () => {
  it('1000 events while Jev is down -> bounded decide invocations, circuit OPEN, zero generative fallback', async () => {
    const { provider, decide } = jevFailer('NETWORK');
    gov.__setJevProviderForTests(provider);
    const generativeSpy = vi.fn(async () => ({ value: 'g', cacheable: false }));
    gov.setGenerativeExecutor(generativeSpy);

    let failed = 0;
    let circuitSkipped = 0;
    for (let i = 0; i < 1000; i++) {
      const res = await gov.request(
        jevOpts({ material: material({ symbol: `DOWN${i}`, fingerprintParts: { n: i } }) }),
      );
      if (res.status === 'FAILED') failed++;
      if (res.status === 'SKIPPED' && res.reason === 'CIRCUIT_OPEN') circuitSkipped++;
    }
    // Cost-storm prevention: only the threshold number of real provider calls.
    expect(decide).toHaveBeenCalledTimes(aiCallGovernor.jevConsecutiveFailureThreshold);
    expect(failed).toBe(aiCallGovernor.jevConsecutiveFailureThreshold);
    expect(circuitSkipped).toBe(1000 - aiCallGovernor.jevConsecutiveFailureThreshold);
    expect(gov.getDiagnostics().circuits['jev']).toBe('OPEN');
    // And NEVER any automatic failover to the expensive generative path.
    expect(generativeSpy).not.toHaveBeenCalled();
  });

  it('generative failures never fall back to Jev', async () => {
    const { provider, decide } = jevSucceed();
    gov.__setJevProviderForTests(provider);
    const run = vi.fn(async () => {
      const err = new Error('gen down') as Error & { kind: string };
      err.kind = 'SERVER';
      throw err;
    });
    gov.setGenerativeExecutor(run);
    for (let i = 0; i < 3; i++) {
      const res = await gov.request(
        genOpts({ material: material({ symbol: `GF${i}`, fingerprintParts: { n: i } }) }, run),
      );
      expect(res.status).toBe('FAILED');
    }
    expect(decide).not.toHaveBeenCalled();
  });
});

// -- observability --------------------------------------------------------------------------

describe('observability', () => {
  it('emits AI_CALL_CONSIDERED and never logs request state bodies', async () => {
    const infoSpy = vi.spyOn(structuredLogger, 'info');
    const { provider } = jevSucceed({ bullish: 0.7 });
    gov.__setJevProviderForTests(provider);
    const secretMarker = 'SECRET_MARKER_XYZ_123';
    await gov.request(
      jevOpts({
        jev: {
          state: { headline: secretMarker, body: 'sensitive content' },
          questions: { q: { type: 'noul', instructions: secretMarker } },
          schemaVersion: 'test-v1',
        },
      }),
    );
    const eventTypes = infoSpy.mock.calls.map((c) => (c[1] as { eventType?: string })?.eventType);
    expect(eventTypes).toContain('AI_CALL_CONSIDERED');
    expect(eventTypes).toContain('AI_CALL_COMPLETED');
    expect(eventTypes).toContain('JEV_DECISION_COMPLETED');
    const serialized = JSON.stringify(infoSpy.mock.calls);
    expect(serialized).not.toContain(secretMarker);
  });

  it('getDiagnostics exposes the full contract shape', async () => {
    const run = vi.fn(async () => ({ value: 'v', cacheable: false }));
    gov.setGenerativeExecutor(run);
    await gov.request(genOpts({ material: material({ symbol: 'D1' }) }, run));
    const d = gov.getDiagnostics();
    expect(d.considered).toBe(1);
    expect(d.called).toBe(1);
    expect(d.cacheHits).toBe(0);
    expect(d.singleflightJoins).toBe(0);
    expect(d.failures).toBe(0);
    expect(d.timeouts).toBe(0);
    expect(d.latencyMs.p50).toBeGreaterThanOrEqual(0);
    expect(d.latencyMs.p95).toBeGreaterThanOrEqual(d.latencyMs.p50);
    expect(d.latencyMs.p99).toBeGreaterThanOrEqual(d.latencyMs.p95);
    expect(d.inFlight).toBe(0);
    expect(d.circuits).toEqual({ jev: 'CLOSED', generative: 'CLOSED' });
    expect(d.cacheSize).toBe(0);
  });

  it('getAvoidanceStats math: avoided = considered - called', async () => {
    expect(gov.getAvoidanceStats()).toEqual({ considered: 0, avoided: 0, avoidanceRate: 0 });
    const run = vi.fn(async () => ({ value: 'v', cacheable: true }));
    gov.setGenerativeExecutor(run);
    await gov.request(genOpts({ material: material({ symbol: 'A1' }) }, run)); // CALLED
    await gov.request(genOpts({ material: material({ symbol: 'A1' }) }, run)); // CACHE_HIT
    const skipped = await gov.request(
      genOpts({ material: material({ symbol: 'A1', fingerprintParts: { n: 2 } }) }, run),
    ); // SYMBOL_COOLDOWN
    expect(skipped.status).toBe('SKIPPED');
    const stats = gov.getAvoidanceStats();
    expect(stats.considered).toBe(3);
    expect(stats.avoided).toBe(2);
    expect(stats.avoidanceRate).toBeCloseTo(2 / 3);
  });
});
