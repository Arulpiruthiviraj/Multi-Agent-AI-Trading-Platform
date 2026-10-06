/**
 * Workstream C (2026-10-06): NewsSymbolExtractor resolution + newsCatalyst signed-sentiment
 * component math. All expectations assert causal/negative/boundary behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NewsSymbolExtractor } from './NewsSymbolExtractor';
import { computeNewsCatalystComponentScore } from '../continuous/ComposableRanking';
import { continuousIntelligence } from '../config/continuousIntelligence';
import type { NormalizedArticle } from './NewsNormalizer';

const extractor = new NewsSymbolExtractor();
const componentCfg = continuousIntelligence.newsCatalystComponent;

function article(title: string, content: string, symbols: string[] = []): NormalizedArticle {
  return {
    id: 'test-article',
    title,
    content,
    url: 'https://example.com/x',
    source: 'TestWire',
    author: 'Test',
    publishedAt: new Date().toISOString(),
    symbols,
    fingerprint: 'fp',
  };
}

describe('NewsSymbolExtractor resolution priority', () => {
  it('keeps provider-supplied symbols first even when the text mentions nothing', () => {
    const out = extractor.extract(article('Quiet day', 'Markets were flat today.', ['TSLA']));
    expect(out).toContain('TSLA');
  });

  it('resolves explicit $TICKER markers with high confidence, even for stoplisted tickers', () => {
    const out = extractor.extract(article('$AI looks overbought', 'Analysts warn $AI is overbought after the run.'));
    expect(out).toContain('AI');
  });

  it('resolves company names to tickers (Apple -> AAPL)', () => {
    const out = extractor.extract(article('Apple beats', 'Apple reported record quarterly earnings.'));
    expect(out).toContain('AAPL');
  });

  it('resolves multiple companies in one article', () => {
    const out = extractor.extract(
      article('Big tech rallies', 'Apple and Microsoft both rose as Nvidia slipped on valuation concerns.'),
    );
    expect(out).toContain('AAPL');
    expect(out).toContain('MSFT');
    expect(out).toContain('NVDA');
  });

  it('resolves bare uppercase lexicon tokens (NVDA, AMD)', () => {
    const out = extractor.extract(article('Chips rally', 'NVDA and AMD led chip stocks higher.'));
    expect(out).toContain('NVDA');
    expect(out).toContain('AMD');
  });

  it('attributes the acquirer, not a spurious ticker, when Google acquires a startup', () => {
    const out = extractor.extract(
      article('Google buys startup', 'Google is acquiring a small AI startup for $2 billion in cash.'),
    );
    // GOOGL via the acquirer's name; "startup" resolves to nothing; "AI" is stoplisted
    // and has no company-name evidence, so it must not false-match.
    expect(out).toEqual(['GOOGL']);
  });

  it('does not add a case-duplicate when a provider symbol matches a text mention', () => {
    const out = extractor.extract(article('Apple beats', 'Apple reported record earnings.', ['aapl']));
    expect(out.filter((s) => s.toUpperCase() === 'AAPL')).toHaveLength(1);
  });
});

describe('NewsSymbolExtractor ambiguity guard (stoplist + evidence rule)', () => {
  it('does not false-match CAT in prose about an animal', () => {
    const out = extractor.extract(article('Lazy afternoon', 'The CAT slept on the mat all day.'));
    expect(out).not.toContain('CAT');
  });

  it('does not false-match AI in prose about artificial intelligence', () => {
    const out = extractor.extract(article('AI boom', 'AI is transforming healthcare, experts say.'));
    expect(out).not.toContain('AI');
  });

  it('does not false-match C in "vitamin C"', () => {
    const out = extractor.extract(article('Health', 'I take vitamin C every morning with breakfast.'));
    expect(out).not.toContain('C');
  });

  it('does not false-match IT / ON as bare tokens', () => {
    const out = extractor.extract(article('Office news', 'The IT department turned the servers ON.'));
    expect(out).not.toContain('IT');
    expect(out).not.toContain('ON');
  });

  it('does not false-match ARE as a bare token', () => {
    const out = extractor.extract(article('Question', 'ARE we there yet, the kids asked.'));
    expect(out).not.toContain('ARE');
  });

  it('accepts an ambiguous ticker when a company-name alias is nearby', () => {
    const out = extractor.extract(
      article('CAT rises', 'CAT rose 3% after Caterpillar raised its full-year guidance.'),
    );
    expect(out).toContain('CAT');
  });

  it('accepts an ambiguous ticker via company name alone (Citi -> C)', () => {
    const out = extractor.extract(article('Bank beats', 'Citigroup beat estimates and raised its dividend.'));
    expect(out).toContain('C');
  });

  it('does not resolve a lowercase common-word company name (an apple != Apple)', () => {
    const out = extractor.extract(article('Orchard', 'an apple a day keeps the doctor away, they say.'));
    expect(out).not.toContain('AAPL');
  });

  it('does not resolve tickers outside the lexicon from prose (no guessing)', () => {
    // XYZCorp is not a real company and not in the lexicon — prose alone must not invent it.
    const out = extractor.extract(article('Local news', 'XYZCorp opened a new warehouse downtown.'));
    expect(out).not.toContain('XYZCORP');
  });
});

describe('computeNewsCatalystComponentScore (signed sentiment is contextual, never directional)', () => {
  const expected = (impact: number, sentiment: number | null): number =>
    Math.min(1, impact * componentCfg.impactMagnitudeWeight +
      (sentiment == null ? 0 : componentCfg.sentimentSalienceWeight * Math.abs(sentiment)));

  it('blends impact magnitude (anchor) with |signed sentiment| from the same config production loads', () => {
    expect(computeNewsCatalystComponentScore(0.6, 0.9)).toBeCloseTo(expected(0.6, 0.9), 10);
    expect(computeNewsCatalystComponentScore(0.6, -0.9)).toBeCloseTo(expected(0.6, -0.9), 10);
  });

  it('treats positive and negative sentiment symmetrically — sign can never become BUY/SELL', () => {
    const positive = computeNewsCatalystComponentScore(0.6, 0.9);
    const negative = computeNewsCatalystComponentScore(0.6, -0.9);
    expect(positive).toBe(negative);
    // The output is a bare 0-1 magnitude: no side, no direction, no recommendation.
    expect(typeof positive).toBe('number');
    expect(positive).toBeGreaterThanOrEqual(0);
    expect(positive).toBeLessThanOrEqual(1);
  });

  it('a strongly positive sentiment alone cannot flip a neutral setup — bounded by the config weight', () => {
    const score = computeNewsCatalystComponentScore(0, 1.0);
    expect(score).toBeLessThanOrEqual(componentCfg.sentimentSalienceWeight);
    expect(score).toBeGreaterThan(0); // contextual evidence still counts, just bounded
    const negativeAlone = computeNewsCatalystComponentScore(0, -1.0);
    expect(negativeAlone).toBe(score); // symmetric
  });

  it('falls back to the magnitude term alone when sentiment is missing', () => {
    expect(computeNewsCatalystComponentScore(0.7, null)).toBeCloseTo(
      0.7 * componentCfg.impactMagnitudeWeight, 10,
    );
  });

  it('clamps to [0,1] and tolerates non-finite sentiment', () => {
    expect(computeNewsCatalystComponentScore(0.9, 1.0)).toBeLessThanOrEqual(1);
    expect(computeNewsCatalystComponentScore(0.9, NaN)).toBeCloseTo(
      0.9 * componentCfg.impactMagnitudeWeight, 10,
    );
  });
});

describe('fetchNewsCatalystScores wires signed sentiment from news_clusters (DB-backed)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus-news-sent-${Date.now()}-${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
  });

  afterEach(() => {
    delete process.env.ARGUS_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* */ }
    }
  });

  it('adjusts the component score with the cluster sentimentScore, derived from the same config', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { newsClusters: table } = await import('../db/schema');
    const { fetchNewsCatalystScores } = await import('../continuous/ComposableRanking');

    await db.insert(table).values({
      id: 'nc-sent-1', title: 'Earnings beat', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), impactScore: 0.6, sentimentScore: 0.9,
      symbols: JSON.stringify(['AAPL']),
    });

    const result = await fetchNewsCatalystScores(['AAPL'], 60 * 60 * 1000);
    const got = result.get('AAPL');
    expect(got?.available).toBe(true);
    const want = Math.min(1,
      0.6 * componentCfg.impactMagnitudeWeight + componentCfg.sentimentSalienceWeight * 0.9);
    expect(got?.score).toBeCloseTo(want, 10);
  });

  it('a cluster without sentimentScore scores on magnitude alone (no sentiment fabrication)', async () => {
    vi.resetModules();
    const { db } = await import('../db');
    const { newsClusters: table } = await import('../db/schema');
    const { fetchNewsCatalystScores } = await import('../continuous/ComposableRanking');

    await db.insert(table).values({
      id: 'nc-sent-2', title: 'No sentiment', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), impactScore: 0.7,
      symbols: JSON.stringify(['MSFT']),
    });

    const result = await fetchNewsCatalystScores(['MSFT'], 60 * 60 * 1000);
    expect(result.get('MSFT')?.score).toBeCloseTo(0.7 * componentCfg.impactMagnitudeWeight, 10);
  });
});
