// LABEL: COMPONENT
/**
 * ==========================================================
 * NewsEngine.jevGovernor.test.ts — 2026-10-11 D1 regression.
 *
 * Defect: NewsEngine.tryJevFirstAnalysis (Phase 2 escalation) constructed
 * `new JevProvider()` with the raw key and called scoreArticleWithJev() directly —
 * no maxInFlight bound, no budget, no circuit breaker, no singleflight/dedup/
 * cache/cooldown. No test pinned the bypass.
 *
 * Fix: the escalation routes through AICallGovernor.request as STRUCTURED_DECISION
 * (kind news_catalyst_triage), mirroring the Phase 1 shadow-path migration (c991233).
 *
 * These tests pin: (1) tryJevFirstAnalysis calls AICallGovernor.request (not
 * JevProvider directly); (2) the request uses capability STRUCTURED_DECISION and
 * kind news_catalyst_triage; (3) SKIPPED/FAILED outcomes fall through to the
 * existing path (return null), preserving fail-closed semantics.
 * ==========================================================
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NewsEngine } from './NewsEngine';
import { AICallGovernor } from '../ai/AICallGovernor';
import { NormalizedArticle } from './NewsNormalizer';

const BASE_ARTICLE: NormalizedArticle = {
  id: 'art-1',
  title: 'Acme beats Q3 revenue expectations',
  content: 'Acme Corp reported Q3 revenue of $2.1B vs $1.9B expected, raising full-year guidance.',
  url: 'https://example.com/news/1',
  source: 'ExampleWire',
  author: 'J. Reporter',
  publishedAt: new Date(Date.now() - 3600_000).toISOString(),
  symbols: ['ACME'],
  fingerprint: 'fp-1',
};

const OPTS = {
  symbol: 'ACME',
  traceId: 'trace-test-1',
  category: 'Earnings',
  credibility: 0.8,
  isNewCluster: true,
  priorArticleCount: 0,
  impactScore01: 0.7,
  timeHorizon: 'short',
};

describe('NewsEngine.tryJevFirstAnalysis governor routing (2026-10-11 D1)', () => {
  let requestSpy: any;

  beforeEach(() => {
    const governor = AICallGovernor.getInstance();
    requestSpy = vi.spyOn(governor, 'request');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes the escalation through AICallGovernor as STRUCTURED_DECISION (kind news_catalyst_triage)', async () => {
    // Governor returns SKIPPED (e.g. budget exhausted): the method must fall through
    // to the existing path (return null), not throw and not call JevProvider directly.
    requestSpy.mockResolvedValue({ status: 'SKIPPED', reason: 'TEST_SKIP', detail: 'test' });

    const engine = NewsEngine.getInstance();
    const result = await (engine as any).tryJevFirstAnalysis(BASE_ARTICLE, OPTS);

    expect(result).toBeNull();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const req = requestSpy.mock.calls[0][0];
    expect(req.capability).toBe('STRUCTURED_DECISION');
    expect(req.kind).toBe('news_catalyst_triage');
    expect(req.material.materiality).toBe('MEDIUM');
    expect(req.material.symbol).toBe('ACME');
    expect(req.jev).toBeDefined();
    expect(req.jev.state).toBeDefined();
    expect(req.jev.questions).toBeDefined();
    expect(req.jev.schemaVersion).toBe('jev-news-triage/v1');
  });

  it('FAILED outcome falls through to the existing path (null), preserving fail-closed semantics', async () => {
    requestSpy.mockResolvedValue({ status: 'FAILED', error: new Error('test failure') });

    const engine = NewsEngine.getInstance();
    const result = await (engine as any).tryJevFirstAnalysis(BASE_ARTICLE, OPTS);

    expect(result).toBeNull();
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});
