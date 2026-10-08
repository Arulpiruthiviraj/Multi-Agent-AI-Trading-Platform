import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  aiAdvisoryService,
  type AIGovernorLike,
} from './AiAdvisoryService';
import type { GovernorRequestOpts, GovernorResult } from './AICallGovernor';
import type { JevDecisionResult } from './JevDecisionProvider';

/**
 * AiAdvisoryService unit tests (2026-10-07, Phase-40 AI value channel).
 * The real AICallGovernor (sibling worker, now landed) is NOT used here — a
 * recording mock implementing its exact request()/GovernorResult<T> shape
 * stands in. No network, no DB, no trading path is touched.
 */

const ARTICLE = {
  id: 'art-123',
  symbol: 'AAPL',
  title: 'Apple beats Q3 expectations',
  summary: 'Apple reported record services revenue and raised guidance.',
  publishedAt: Date.now(),
};

const JEV_PAYLOAD: JevDecisionResult = {
  answers: {
    relevant: { type: 'noul', noul: 0.93 },
    catalyst_type: {
      type: 'choice',
      choice: 'earnings',
      probabilities: { earnings: 0.8, other: 0.2 },
      confidence: 0.8,
    },
    materiality: {
      type: 'score',
      score: 4,
      legend: {},
      probabilities: {},
      confidence: 0.7,
    },
    needs_deeper_research: { type: 'noul', noul: 0.2 },
  },
  model: 'jev-1.13.0',
  inputTokens: 512,
  latencyMs: 210,
};

const CALLED_RESULT: GovernorResult<JevDecisionResult> = {
  status: 'CALLED',
  result: JEV_PAYLOAD,
  latencyMs: 210,
};

function mockGovernor(
  result: GovernorResult<JevDecisionResult>,
): AIGovernorLike & { requests: Array<GovernorRequestOpts<JevDecisionResult>> } {
  const requests: Array<GovernorRequestOpts<JevDecisionResult>> = [];
  return {
    requests,
    async request<T>(opts: GovernorRequestOpts<T>): Promise<GovernorResult<T>> {
      requests.push(opts as GovernorRequestOpts<JevDecisionResult>);
      return result as GovernorResult<T>;
    },
  };
}

describe('AiAdvisoryService', () => {
  beforeEach(() => {
    aiAdvisoryService.resetForTesting();
  });

  afterEach(() => {
    aiAdvisoryService.resetForTesting();
    vi.restoreAllMocks();
  });

  it('news catalyst builds exactly ONE Jev-shaped governor request with 4 questions', async () => {
    const governor = mockGovernor(CALLED_RESULT);
    aiAdvisoryService.setGovernorForTesting(governor);

    const before = Date.now();
    aiAdvisoryService.considerNewsCatalyst(ARTICLE);
    await aiAdvisoryService.drainPendingAdvisoryWork();

    expect(governor.requests).toHaveLength(1);
    const req = governor.requests[0];
    expect(req.capability).toBe('STRUCTURED_DECISION');
    expect(req.kind).toBe('news_catalyst_triage');
    expect(typeof req.run).toBe('function');

    // Material envelope (sibling's AiCallMaterial shape).
    expect(req.material.symbol).toBe('AAPL');
    expect(req.material.materiality).toBe('HIGH');
    expect(req.material.fingerprintParts).toEqual({ articleId: 'art-123', symbol: 'AAPL' });
    expect(req.material.decisionDeadlineMs).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(req.material.decisionDeadlineMs).toBeLessThanOrEqual(Date.now() + 60_000);

    // Jev spec.
    const jev = req.jev!;
    expect(jev).toBeDefined();
    expect(typeof jev.schemaVersion).toBe('string');
    const questionKeys = Object.keys(jev.questions);
    expect(questionKeys).toEqual(['relevant', 'catalyst_type', 'materiality', 'needs_deeper_research']);
    expect((jev.questions['relevant'] as { type: string }).type).toBe('noul');
    expect((jev.questions['catalyst_type'] as { type: string }).type).toBe('choice');
    expect((jev.questions['materiality'] as { type: string }).type).toBe('score');
    expect((jev.questions['needs_deeper_research'] as { type: string }).type).toBe('noul');

    const criteria = (jev.questions['catalyst_type'] as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria).sort()).toEqual(
      ['analyst', 'earnings', 'guidance', 'legal', 'macro', 'other', 'product', 'regulatory'].sort(),
    );
    const levels = (jev.questions['materiality'] as { criteria: string[] }).criteria;
    expect(levels).toHaveLength(5);

    const state = jev.state as Record<string, unknown>;
    expect(state.symbol).toBe('AAPL');
    expect(state.title).toBe(ARTICLE.title);
    expect(state.summary).toBe(ARTICLE.summary);
    expect(state.publishedAt).toBeDefined();

    // CALLED -> structured observability + advisory note stored.
    const note = aiAdvisoryService.getAdvisoryNote('AAPL');
    expect(note).toBeTruthy();
    expect(note!).toContain('AAPL');
    expect(note!).toContain('earnings');
  });

  it('duplicate article takes a single consideration path (fingerprint dedupe)', async () => {
    const governor = mockGovernor(CALLED_RESULT);
    aiAdvisoryService.setGovernorForTesting(governor);

    aiAdvisoryService.considerNewsCatalyst(ARTICLE);
    aiAdvisoryService.considerNewsCatalyst(ARTICLE);
    aiAdvisoryService.considerNewsCatalyst({ ...ARTICLE });
    await aiAdvisoryService.drainPendingAdvisoryWork();

    expect(governor.requests).toHaveLength(1);
  });

  it('governor SKIPPED -> no throw, no cache write', async () => {
    const governor = mockGovernor({ status: 'SKIPPED', reason: 'GLOBAL_BUDGET', detail: 'budget exhausted' });
    aiAdvisoryService.setGovernorForTesting(governor);

    expect(() => aiAdvisoryService.considerNewsCatalyst(ARTICLE)).not.toThrow();
    await aiAdvisoryService.drainPendingAdvisoryWork();

    expect(governor.requests).toHaveLength(1);
    expect(aiAdvisoryService.getAdvisoryNote('AAPL')).toBeNull();
  });

  it('governor FAILED -> no throw, no cache write', async () => {
    const governor = mockGovernor({ status: 'FAILED', error: new Error('timeout'), kind: 'TIMEOUT' });
    aiAdvisoryService.setGovernorForTesting(governor);

    expect(() => aiAdvisoryService.considerNewsCatalyst(ARTICLE)).not.toThrow();
    await aiAdvisoryService.drainPendingAdvisoryWork();

    expect(aiAdvisoryService.getAdvisoryNote('AAPL')).toBeNull();
  });

  it('CACHE_HIT also stores an advisory note', async () => {
    const governor = mockGovernor({ status: 'CACHE_HIT', result: JEV_PAYLOAD });
    aiAdvisoryService.setGovernorForTesting(governor);

    aiAdvisoryService.considerNewsCatalyst(ARTICLE);
    await aiAdvisoryService.drainPendingAdvisoryWork();

    expect(aiAdvisoryService.getAdvisoryNote('AAPL')).toBeTruthy();
  });

  it('advisory note expires after TTL', async () => {
    const governor = mockGovernor(CALLED_RESULT);
    aiAdvisoryService.setGovernorForTesting(governor);

    const t0 = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    aiAdvisoryService.considerNewsCatalyst(ARTICLE);
    await aiAdvisoryService.drainPendingAdvisoryWork();
    expect(aiAdvisoryService.getAdvisoryNote('AAPL')).toBeTruthy();

    // Just inside TTL: still present.
    nowSpy.mockReturnValue(t0 + 119_999);
    expect(aiAdvisoryService.getAdvisoryNote('AAPL')).toBeTruthy();

    // Past TTL: gone.
    nowSpy.mockReturnValue(t0 + 120_001);
    expect(aiAdvisoryService.getAdvisoryNote('AAPL')).toBeNull();
  });

  it('note cache holds at most 200 entries (oldest evicted)', async () => {
    const governor = mockGovernor(CALLED_RESULT);
    aiAdvisoryService.setGovernorForTesting(governor);

    for (let i = 0; i < 201; i++) {
      aiAdvisoryService.considerNewsCatalyst({ ...ARTICLE, id: `art-${i}`, symbol: `SYM${i}` });
    }
    await aiAdvisoryService.drainPendingAdvisoryWork();

    expect(governor.requests).toHaveLength(201);
    // Oldest evicted...
    expect(aiAdvisoryService.getAdvisoryNote('SYM0')).toBeNull();
    // ...newest retained.
    expect(aiAdvisoryService.getAdvisoryNote('SYM200')).toBeTruthy();
  });

  it('getAdvisoryNote returns null when empty', () => {
    expect(aiAdvisoryService.getAdvisoryNote('AAPL')).toBeNull();
    expect(aiAdvisoryService.getAdvisoryNote('')).toBeNull();
  });

  it('storing a note sweeps expired entries instead of evicting a live one', async () => {
    const governor = mockGovernor(CALLED_RESULT);
    aiAdvisoryService.setGovernorForTesting(governor);

    const t0 = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    for (let i = 0; i < 200; i++) {
      aiAdvisoryService.considerNewsCatalyst({ ...ARTICLE, id: `sweep-${i}`, symbol: `SWP${i}` });
    }
    await aiAdvisoryService.drainPendingAdvisoryWork();
    expect(aiAdvisoryService.__noteCacheSizeForTests()).toBe(200);

    // Past the 120s TTL every stored note is expired; the next store must
    // delete them (not merely skip them on read) instead of evicting oldest.
    nowSpy.mockReturnValue(t0 + 120_001);
    aiAdvisoryService.considerNewsCatalyst({ ...ARTICLE, id: 'sweep-new', symbol: 'SWPNEW' });
    await aiAdvisoryService.drainPendingAdvisoryWork();
    expect(aiAdvisoryService.__noteCacheSizeForTests()).toBe(1);
    expect(aiAdvisoryService.getAdvisoryNote('SWPNEW')).toBeTruthy();
    expect(aiAdvisoryService.getAdvisoryNote('SWP0')).toBeNull();
    nowSpy.mockRestore();
  });

  it('quant candidate advisory requests thesis/risk questions and writes no note', async () => {
    const governor = mockGovernor({
      status: 'CALLED',
      result: {
        answers: {
          thesis_supported: { type: 'noul', noul: 0.6 },
          material_risk_event: { type: 'noul', noul: 0.05 },
        },
        model: 'jev-1.13.0',
        inputTokens: 128,
        latencyMs: 180,
      },
      latencyMs: 180,
    });
    aiAdvisoryService.setGovernorForTesting(governor);

    aiAdvisoryService.considerQuantCandidateAdvisory('MSFT', {
      strategyId: 'MOMENTUM_BREAKOUT',
      side: 'BUY',
      traceId: 'trace-1',
    });
    await aiAdvisoryService.drainPendingAdvisoryWork();

    expect(governor.requests).toHaveLength(1);
    const req = governor.requests[0];
    expect(req.capability).toBe('STRUCTURED_DECISION');
    expect(req.kind).toBe('quant_candidate_advisory');
    expect(req.material.materiality).toBe('MEDIUM');
    expect(req.material.symbol).toBe('MSFT');
    expect(req.material.fingerprintParts).toEqual({ traceId: 'trace-1', symbol: 'MSFT' });
    expect(req.material.traceId).toBe('trace-1');
    const jev = req.jev!;
    expect(Object.keys(jev.questions)).toEqual(['thesis_supported', 'material_risk_event']);
    expect((jev.questions['thesis_supported'] as { type: string }).type).toBe('noul');
    expect((jev.questions['material_risk_event'] as { type: string }).type).toBe('noul');
    expect(jev.state).toMatchObject({
      symbol: 'MSFT',
      strategyId: 'MOMENTUM_BREAKOUT',
      side: 'BUY',
      traceId: 'trace-1',
    });
    // Observability only — no advisory note written for this channel.
    expect(aiAdvisoryService.getAdvisoryNote('MSFT')).toBeNull();
  });

  it('service never rejects: throwing governor, unconfigured (SKIPPED/NO_API_KEY), malformed input', async () => {
    const throwing: AIGovernorLike = {
      async request<T>(): Promise<GovernorResult<T>> {
        throw new Error('boom');
      },
    };
    aiAdvisoryService.setGovernorForTesting(throwing);

    expect(() => aiAdvisoryService.considerNewsCatalyst(ARTICLE)).not.toThrow();
    expect(() =>
      aiAdvisoryService.considerQuantCandidateAdvisory('MSFT', {
        strategyId: 'X',
        side: 'BUY',
        traceId: 't',
      }),
    ).not.toThrow();
    await expect(aiAdvisoryService.drainPendingAdvisoryWork()).resolves.toBeUndefined();

    // Unconfigured governor (no JEV_API_KEY): silent no-op, no note.
    aiAdvisoryService.setGovernorForTesting(
      mockGovernor({ status: 'SKIPPED', reason: 'NO_API_KEY', detail: 'no usable JEV_API_KEY' }),
    );
    expect(() => aiAdvisoryService.considerNewsCatalyst(ARTICLE)).not.toThrow();
    await aiAdvisoryService.drainPendingAdvisoryWork();
    expect(aiAdvisoryService.getAdvisoryNote('AAPL')).toBeNull();

    // Malformed input: never throws.
    expect(() => aiAdvisoryService.considerNewsCatalyst({} as never)).not.toThrow();
    expect(() =>
      aiAdvisoryService.considerQuantCandidateAdvisory('', { strategyId: '', side: '', traceId: '' }),
    ).not.toThrow();
    await expect(aiAdvisoryService.drainPendingAdvisoryWork()).resolves.toBeUndefined();
  });
});
