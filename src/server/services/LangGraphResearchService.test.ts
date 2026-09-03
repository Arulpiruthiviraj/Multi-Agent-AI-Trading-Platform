import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('LangGraphResearchService', () => {
  const ENV_KEY = 'LANGGRAPH_RESEARCH_ENABLED';
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
    fetchSpy?.mockRestore();
  });

  function goodEnvelope(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      runId: 'run-1', correlationId: 'corr-1', strategyId: 'GOLDEN_SMA', graphVersion: 'v1',
      status: 'COMPLETED',
      result: {
        lifecycleStatusAtRequest: 'UNTESTED', live: 'NO-GO', failedGatesAtRequest: ['BACKTEST_PASS'],
        recommendation: 'NOT_YET_ELIGIBLE', confidence: 0.2, rationale: 'x', limitations: [], evidenceUsed: [],
        counterEvidence: [], missingEvidence: ['No organic paper trades recorded yet (paperTrades is 0).'],
        evidenceStrength: 'WEAK', evidenceStrengthRationale: '1/22 Argus evidence gates currently pass.',
        humanReviewRequired: true,
        provenance: { source: 'argus_strategy_evidence_endpoint', strategyId: 'GOLDEN_SMA', fetchedAt: '2026-01-01T00:00:00Z' },
        modelGeneratedNarrative: 'y',
      },
      error: null, durationMs: 10, nodesExecuted: ['fetch_evidence'], providerModel: 'llama3.2:latest',
      ...overrides,
    };
  }

  it('returns DISABLED without making any network call when the master flag is unset', async () => {
    fetchSpy = vi.spyOn(global, 'fetch');
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome).toEqual({ ok: false, reason: 'DISABLED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a valid envelope when the flag is enabled and the service responds correctly', async () => {
    process.env[ENV_KEY] = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => goodEnvelope(),
    } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.envelope.result?.recommendation).toBe('NOT_YET_ELIGIBLE');
    }
  });

  it('returns UNAVAILABLE when the service is unreachable', async () => {
    process.env[ENV_KEY] = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome).toEqual({ ok: false, reason: 'UNAVAILABLE', detail: 'connect ECONNREFUSED' });
  });

  it('returns TIMEOUT when the request aborts', async () => {
    process.env[ENV_KEY] = 'true';
    const timeoutError = new Error('The operation was aborted');
    timeoutError.name = 'TimeoutError';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(timeoutError);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('TIMEOUT');
  });

  it('returns UNAVAILABLE on a non-2xx HTTP status', async () => {
    process.env[ENV_KEY] = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome).toEqual({ ok: false, reason: 'UNAVAILABLE', detail: 'HTTP 503' });
  });

  it('rejects a response body that is not valid JSON', async () => {
    process.env[ENV_KEY] = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new Error('bad json'); },
    } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('INVALID_RESPONSE');
  });

  it('rejects a response missing required result fields, rather than coercing it into something usable', async () => {
    process.env[ENV_KEY] = 'true';
    const malformed = goodEnvelope();
    delete (malformed.result as any).confidence;
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => malformed } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('INVALID_RESPONSE');
  });

  it('rejects a response whose confidence is out of [0,1] range', async () => {
    process.env[ENV_KEY] = 'true';
    const malformed = goodEnvelope();
    (malformed.result as any).confidence = 1.5;
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => malformed } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
  });

  it('rejects a response echoing a DIFFERENT strategyId than what was requested (anti-fabrication / cross-request mismatch guard)', async () => {
    process.env[ENV_KEY] = 'true';
    const mismatched = goodEnvelope({ strategyId: 'SOME_OTHER_STRATEGY' });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => mismatched } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('INVALID_RESPONSE');
  });

  it('rejects a response echoing a DIFFERENT correlationId than what was sent', async () => {
    process.env[ENV_KEY] = 'true';
    const mismatched = goodEnvelope({ correlationId: 'some-other-correlation-id' });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => mismatched } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
  });

  it('rejects an out-of-enum recommendation value', async () => {
    process.env[ENV_KEY] = 'true';
    const malformed = goodEnvelope();
    (malformed.result as any).recommendation = 'DEFINITELY_PROMOTE_NOW';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => malformed } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
  });

  it('accepts a FAILED-status envelope (a real, honestly reported graph failure) as ok:true', async () => {
    process.env[ENV_KEY] = 'true';
    const failed = goodEnvelope({ status: 'FAILED', result: null, error: 'ARGUS_UNREACHABLE: refused' });
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => failed } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.envelope.status).toBe('FAILED');
      expect(outcome.envelope.error).toBe('ARGUS_UNREACHABLE: refused');
    }
  });

  it('accepts an empty modelGeneratedNarrative (the real, honest shape when the insufficient-evidence shortcut ran and no LLM was called)', async () => {
    process.env[ENV_KEY] = 'true';
    const noLlmRan = goodEnvelope();
    (noLlmRan.result as any).recommendation = 'INSUFFICIENT_EVIDENCE';
    (noLlmRan.result as any).confidence = 0;
    (noLlmRan.result as any).modelGeneratedNarrative = '';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => noLlmRan } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.envelope.result?.recommendation).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('rejects a response missing the new Phase 3 evidenceStrength field', async () => {
    process.env[ENV_KEY] = 'true';
    const malformed = goodEnvelope();
    delete (malformed.result as any).evidenceStrength;
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => malformed } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.reason).toBe('INVALID_RESPONSE');
  });

  it('rejects an out-of-enum evidenceStrength value', async () => {
    process.env[ENV_KEY] = 'true';
    const malformed = goodEnvelope();
    (malformed.result as any).evidenceStrength = 'VERY_CONFIDENT';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => malformed } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
  });

  it('rejects a response where humanReviewRequired is not a boolean', async () => {
    process.env[ENV_KEY] = 'true';
    const malformed = goodEnvelope();
    (malformed.result as any).humanReviewRequired = 'yes';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => malformed } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
  });

  it('rejects a response where counterEvidence is not a string array', async () => {
    process.env[ENV_KEY] = 'true';
    const malformed = goodEnvelope();
    (malformed.result as any).counterEvidence = 'not an array';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => malformed } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(false);
  });

  it('accepts real, non-empty counterEvidence (the whole point of Phase 3 is that this is not silently dropped)', async () => {
    process.env[ENV_KEY] = 'true';
    const withCounter = goodEnvelope();
    (withCounter.result as any).counterEvidence = ['Sample size is thin.', 'No walk-forward evidence yet.'];
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => withCounter } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const outcome = await langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.envelope.result?.counterEvidence).toEqual(['Sample size is thin.', 'No walk-forward evidence yet.']);
  });

  it('health() reports disconnected without a network call when the flag is off', async () => {
    fetchSpy = vi.spyOn(global, 'fetch');
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const health = await langGraphResearchService.health();
    expect(health.connected).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('health() reports connected when the service answers 200', async () => {
    process.env[ENV_KEY] = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as any);
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    const health = await langGraphResearchService.health();
    expect(health.connected).toBe(true);
  });

  it('never throws, even when fetch itself throws a completely unexpected error', async () => {
    process.env[ENV_KEY] = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => { throw new TypeError('unexpected'); });
    const { langGraphResearchService } = await import('./LangGraphResearchService');
    await expect(langGraphResearchService.requestStrategyGraduationRecommendation('GOLDEN_SMA', 'corr-1')).resolves.toMatchObject({ ok: false });
  });
});
