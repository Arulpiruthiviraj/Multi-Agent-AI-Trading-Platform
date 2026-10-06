import { describe, it, expect } from 'vitest';
import {
  aggregateWeeklyDigest,
  DEFAULT_MIN_OCCURRENCES,
  type DailyReflectionInput,
} from './weeklyDigestAggregate';

function day(tradingDate: string, partial: Partial<DailyReflectionInput> = {}): DailyReflectionInput {
  return {
    tradingDate,
    blindSpots: [],
    findings: [],
    narratives: [],
    rejectedCandidateAudits: [],
    ...partial,
  };
}

function finding(symbol: string, classification: string, filteredReasons: string[] = []) {
  return { symbol, classification, filteredReasons };
}

describe('weeklyDigestAggregate - recurrence gate', () => {
  it('excludes a pattern that occurred on only one day (one-day anomalies are never promoted)', () => {
    const days = [
      day('2026-10-05', { findings: [finding('AAA', 'DATA_QUALITY_GAP', ['ADV_DATA_UNAVAILABLE'])] }),
      day('2026-10-06', { findings: [finding('BBB', 'CORRECT_NON_ACTION', ['PRICE'])] }),
      day('2026-10-07', { findings: [] }),
    ];
    const out = aggregateWeeklyDigest(days);
    expect(out.find((p) => p.patternKey === 'FATE_DATA_QUALITY_GAP')).toBeUndefined();
    expect(out.find((p) => p.patternKey === 'FILTER_ADV_DATA_UNAVAILABLE')).toBeUndefined();
  });

  it('includes a pattern that occurred on two days, with per-pattern symbols and dates', () => {
    const days = [
      day('2026-10-05', { findings: [finding('AAA', 'DATA_QUALITY_GAP', ['ADV_DATA_UNAVAILABLE'])] }),
      day('2026-10-06', { findings: [finding('BBB', 'DATA_QUALITY_GAP', ['ADV_DATA_UNAVAILABLE']), finding('CCC', 'CORRECT_NON_ACTION', ['PRICE'])] }),
    ];
    const out = aggregateWeeklyDigest(days);
    const fate = out.find((p) => p.patternKey === 'FATE_DATA_QUALITY_GAP')!;
    expect(fate).toBeDefined();
    expect(fate.occurrences).toBe(2);
    expect(fate.symbols).toEqual(['AAA', 'BBB']);
    expect(fate.dates).toEqual(['2026-10-05', '2026-10-06']);
    expect(fate.firstSeen).toBe('2026-10-05');
    expect(fate.lastSeen).toBe('2026-10-06');

    const filter = out.find((p) => p.patternKey === 'FILTER_ADV_DATA_UNAVAILABLE')!;
    expect(filter.occurrences).toBe(2);
    expect(filter.symbols).toEqual(['AAA', 'BBB']);

    // Single-day patterns from the same input stay excluded.
    expect(out.find((p) => p.patternKey === 'FATE_CORRECT_NON_ACTION')).toBeUndefined();
    expect(out.find((p) => p.patternKey === 'FILTER_PRICE')).toBeUndefined();
  });

  it('honours a configurable minOccurrences above the default', () => {
    const days = [
      day('2026-10-05', { findings: [finding('AAA', 'NEWS_BLIND_SPOT')] }),
      day('2026-10-06', { findings: [finding('BBB', 'NEWS_BLIND_SPOT')] }),
      day('2026-10-07', { findings: [finding('CCC', 'NEWS_BLIND_SPOT')] }),
    ];
    expect(aggregateWeeklyDigest(days, { minOccurrences: 3 }).map((p) => p.patternKey))
      .toContain('FATE_NEWS_BLIND_SPOT');
    expect(aggregateWeeklyDigest(days, { minOccurrences: 4 }).map((p) => p.patternKey))
      .not.toContain('FATE_NEWS_BLIND_SPOT');
  });

  it('defaults to a 2-day recurrence requirement', () => {
    expect(DEFAULT_MIN_OCCURRENCES).toBe(2);
  });

  it('counts a repeated date only once (dedup, not double-count)', () => {
    const days = [
      day('2026-10-05', { findings: [finding('AAA', 'DATA_QUALITY_GAP')] }),
      day('2026-10-05', { findings: [finding('BBB', 'DATA_QUALITY_GAP')] }),
      day('2026-10-06', { findings: [finding('CCC', 'DATA_QUALITY_GAP')] }),
    ];
    const fate = aggregateWeeklyDigest(days).find((p) => p.patternKey === 'FATE_DATA_QUALITY_GAP')!;
    expect(fate.occurrences).toBe(2);
    expect(fate.symbols).toEqual(['AAA', 'BBB', 'CCC']);
  });
});

describe('weeklyDigestAggregate - pattern key derivation', () => {
  it('passes daily blind-spot patternKeys through with their own symbol evidence', () => {
    const days = [
      day('2026-10-05', { blindSpots: [{ patternKey: 'NULL_ADV_LIQUIDITY_GATE', pattern: 'null adv gate', affectedSymbolCount: 4, evidence: 'AAA, BBB' }] }),
      day('2026-10-06', { blindSpots: [{ patternKey: 'NULL_ADV_LIQUIDITY_GATE', pattern: 'null adv gate', affectedSymbolCount: 5, evidence: 'CCC, DDD' }] }),
    ];
    const spot = aggregateWeeklyDigest(days).find((p) => p.patternKey === 'NULL_ADV_LIQUIDITY_GATE')!;
    expect(spot.occurrences).toBe(2);
    expect(spot.symbols).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    expect(spot.exampleEvidence).toBe('null adv gate');
  });

  it('derives FILTER_<reason> keys from filter reasons (e.g. RANK_CAP)', () => {
    const days = [
      day('2026-10-05', { findings: [finding('AAA', 'FILTERED_OTHER', ['RANK_CAP'])] }),
      day('2026-10-07', { findings: [finding('BBB', 'FILTERED_OTHER', ['RANK_CAP'])] }),
    ];
    const key = aggregateWeeklyDigest(days).find((p) => p.patternKey === 'FILTER_RANK_CAP')!;
    expect(key.occurrences).toBe(2);
    expect(key.symbols).toEqual(['AAA', 'BBB']);
  });

  it('derives NO_FRESH_DATA from real news-discard events in narratives', () => {
    const mk = (sym: string) => ({
      symbol: sym,
      primaryFailureCategory: 'DATA' as string,
      newsTimeline: [{ eventType: 'NEWS_IDEA_DISCARDED_NO_FRESH_DATA' }],
    });
    const days = [
      day('2026-10-05', { narratives: [mk('AAA')] }),
      day('2026-10-06', { narratives: [mk('BBB')] }),
    ];
    const key = aggregateWeeklyDigest(days).find((p) => p.patternKey === 'NO_FRESH_DATA')!;
    expect(key.occurrences).toBe(2);
    expect(key.symbols).toEqual(['AAA', 'BBB']);
  });

  it('derives FAILURE_<category> keys but skips NONE', () => {
    const days = [
      day('2026-10-05', { narratives: [
        { symbol: 'AAA', primaryFailureCategory: 'CONSENSUS', newsTimeline: [] },
        { symbol: 'ZZZ', primaryFailureCategory: 'NONE', newsTimeline: [] },
      ] }),
      day('2026-10-06', { narratives: [{ symbol: 'BBB', primaryFailureCategory: 'CONSENSUS', newsTimeline: [] }] }),
    ];
    const out = aggregateWeeklyDigest(days);
    expect(out.find((p) => p.patternKey === 'FAILURE_CONSENSUS')!.symbols).toEqual(['AAA', 'BBB']);
    expect(out.find((p) => p.patternKey === 'FAILURE_NONE')).toBeUndefined();
  });

  it('derives AUDIT_<verdict> keys from rejected-candidate audits', () => {
    const days = [
      day('2026-10-05', { rejectedCandidateAudits: [{ symbol: 'AAA', verdict: 'POTENTIAL_MISSED_OPPORTUNITY' }] }),
      day('2026-10-06', { rejectedCandidateAudits: [{ symbol: 'BBB', verdict: 'POTENTIAL_MISSED_OPPORTUNITY' }] }),
    ];
    const key = aggregateWeeklyDigest(days).find((p) => p.patternKey === 'AUDIT_POTENTIAL_MISSED_OPPORTUNITY')!;
    expect(key.occurrences).toBe(2);
  });

  it('derives UNIVERSE_MISS_<cause> keys from reconciled never-seen movers', () => {
    const days = [
      day('2026-10-05', { neverSeenMovers: [{ symbol: 'AAA', neverSeenCause: 'no_snapshot_data' }] }),
      day('2026-10-06', { neverSeenMovers: [{ symbol: 'BBB', neverSeenCause: 'no_snapshot_data' }, { symbol: 'CCC', neverSeenCause: null }] }),
    ];
    const out = aggregateWeeklyDigest(days);
    expect(out.find((p) => p.patternKey === 'UNIVERSE_MISS_NO_SNAPSHOT_DATA')!.symbols).toEqual(['AAA', 'BBB']);
    // Null cause normalizes to UNKNOWN_CAUSE and occurred only once -> excluded.
    expect(out.find((p) => p.patternKey === 'UNIVERSE_MISS_UNKNOWN_CAUSE')).toBeUndefined();
  });

  it('returns no patterns for empty input', () => {
    expect(aggregateWeeklyDigest([])).toEqual([]);
  });

  it('caps symbols per pattern and orders deterministically', () => {
    const symbols = Array.from({ length: 60 }, (_, i) => `S${String(i).padStart(3, '0')}`);
    const days = [
      day('2026-10-05', { findings: symbols.slice(0, 30).map((s) => finding(s, 'DATA_QUALITY_GAP')) }),
      day('2026-10-06', { findings: symbols.slice(30).map((s) => finding(s, 'DATA_QUALITY_GAP')) }),
    ];
    const out = aggregateWeeklyDigest(days, { maxSymbolsPerPattern: 50 });
    const fate = out.find((p) => p.patternKey === 'FATE_DATA_QUALITY_GAP')!;
    expect(fate.symbols).toHaveLength(50);
    // Deterministic: most recurring first, then alphabetical.
    const keys = out.map((p) => p.patternKey);
    expect([...keys].sort()).toBeDefined();
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1];
      const cur = out[i];
      expect(prev.occurrences > cur.occurrences ||
        (prev.occurrences === cur.occurrences && prev.patternKey <= cur.patternKey)).toBe(true);
    }
  });
});
