/**
 * Weekly reflection digest aggregation - PURE module (zero imports: no DB, no config, no I/O).
 *
 * Aggregates per-day post-market reflection evidence into recurring blind-spot patterns for
 * one calendar week. A pattern enters the digest ONLY if it occurred on at least
 * `minOccurrences` distinct trading days in the week (default 2) - a one-day anomaly is
 * never promoted to an architecture-level conclusion, no matter how many symbols it touched
 * that day. This is the multi-day recurrence gate PostMarketAnalysis.ts's own header calls
 * for ("a single day is not enough to call anything 'recurring'").
 *
 * Pattern keys are derived ONLY from real evidence chains already present in the daily
 * reports - never invented:
 *  - daily blind-spot patternKeys (stable cross-day identifiers, e.g. NULL_ADV_LIQUIDITY_GATE)
 *  - discovery filter reasons ......... FILTER_<REASON> (e.g. FILTER_RANK_CAP)
 *  - per-symbol fate classifications ... FATE_<CLASSIFICATION> (fate distribution)
 *  - news ideas discarded for stale data NO_FRESH_DATA (real NEWS_IDEA_DISCARDED_NO_FRESH_DATA events)
 *  - narrative failure categories ...... FAILURE_<CATEGORY>
 *  - rejected-candidate audit verdicts . AUDIT_<VERDICT>
 *  - reconciled never-seen movers ...... UNIVERSE_MISS_<CAUSE> (workstream H's never_seen_cause;
 *    absent until H's mover_coverage table exists - then it flows through honestly)
 *
 * Diagnostic only: this module computes summaries; it cannot influence the live pipeline
 * (see reflectionSafety.test.ts for the structural guarantees).
 */

/** Minimum distinct trading days a pattern must appear on to enter the digest.
 *  Follows computeMultiDayRollup()'s own precedent (>= 2 days to call anything recurring). */
export const DEFAULT_MIN_OCCURRENCES = 2;

/** Hard cap on symbols stored per pattern - keeps digest rows bounded on noisy days. */
export const DEFAULT_MAX_SYMBOLS_PER_PATTERN = 50;

export interface DailyReflectionInput {
  tradingDate: string; // 'YYYY-MM-DD'
  blindSpots: Array<{ patternKey: string; pattern: string; affectedSymbolCount: number; evidence: string }>;
  findings: Array<{ symbol: string; classification: string; filteredReasons: string[] }>;
  narratives: Array<{ symbol: string; primaryFailureCategory: string; newsTimeline: Array<{ eventType: string }> }>;
  rejectedCandidateAudits: Array<{ symbol: string; verdict: string }>;
  /** Workstream H feed - empty until mover_coverage exists; never fabricated. */
  neverSeenMovers?: Array<{ symbol: string; neverSeenCause: string | null }>;
}

export interface WeeklyDigestPattern {
  patternKey: string;
  /** Distinct trading days in the week on which this pattern occurred. */
  occurrences: number;
  /** Distinct symbols touched, capped at maxSymbolsPerPattern, sorted for determinism. */
  symbols: string[];
  /** Trading dates on which it occurred, ascending. */
  dates: string[];
  firstSeen: string;
  lastSeen: string;
  /** Human-readable example: the daily blind-spot text when available, else a generated summary. */
  exampleEvidence: string;
}

export interface AggregateOptions {
  minOccurrences?: number;
  maxSymbolsPerPattern?: number;
}

interface PatternAccumulator {
  dates: Set<string>;
  symbols: Set<string>;
  exampleEvidence: string;
}

function normalizeCause(cause: string | null): string {
  const raw = (cause ?? 'unknown').trim() || 'unknown';
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** The daily blind-spot `evidence` field is the report's own comma-joined symbol list
 *  (see PostMarketAnalysis.detectBlindSpots) - parse it back rather than inventing one. */
function parseEvidenceSymbols(evidence: string): string[] {
  return evidence.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function aggregateWeeklyDigest(
  days: DailyReflectionInput[],
  opts: AggregateOptions = {},
): WeeklyDigestPattern[] {
  const minOccurrences = Math.max(1, opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES);
  const maxSymbols = Math.max(1, opts.maxSymbolsPerPattern ?? DEFAULT_MAX_SYMBOLS_PER_PATTERN);

  const acc = new Map<string, PatternAccumulator>();
  const touch = (patternKey: string, date: string, symbols: string[], exampleEvidence: string): void => {
    let a = acc.get(patternKey);
    if (!a) {
      a = { dates: new Set(), symbols: new Set(), exampleEvidence };
      acc.set(patternKey, a);
    }
    a.dates.add(date);
    for (const s of symbols) a.symbols.add(s);
    // Keep the earliest day's evidence text as the example - it is the pattern's first
    // observed description, not a blend of different days' wordings.
  };

  for (const day of days) {
    const date = day.tradingDate;

    for (const spot of day.blindSpots) {
      touch(spot.patternKey, date, parseEvidenceSymbols(spot.evidence), spot.pattern);
    }

    const filterSymbols = new Map<string, Set<string>>();
    const fateSymbols = new Map<string, Set<string>>();
    for (const f of day.findings) {
      for (const reason of f.filteredReasons) {
        const key = `FILTER_${reason}`;
        if (!filterSymbols.has(key)) filterSymbols.set(key, new Set());
        filterSymbols.get(key)!.add(f.symbol);
      }
      const fateKey = `FATE_${f.classification}`;
      if (!fateSymbols.has(fateKey)) fateSymbols.set(fateKey, new Set());
      fateSymbols.get(fateKey)!.add(f.symbol);
    }
    for (const [key, symbols] of filterSymbols) {
      touch(key, date, [...symbols], `Discovery filter reason ${key.slice('FILTER_'.length)} recurred across the week.`);
    }
    for (const [key, symbols] of fateSymbols) {
      touch(key, date, [...symbols], `Per-symbol fate ${key.slice('FATE_'.length)} recurred across the week.`);
    }

    const noFreshDataSymbols = new Set<string>();
    const failureSymbols = new Map<string, Set<string>>();
    for (const n of day.narratives) {
      if (n.newsTimeline.some((e) => e.eventType === 'NEWS_IDEA_DISCARDED_NO_FRESH_DATA')) {
        noFreshDataSymbols.add(n.symbol);
      }
      // 'NONE' means no failure to explain - recurring non-failures are not a blind spot.
      if (n.primaryFailureCategory && n.primaryFailureCategory !== 'NONE') {
        const key = `FAILURE_${n.primaryFailureCategory}`;
        if (!failureSymbols.has(key)) failureSymbols.set(key, new Set());
        failureSymbols.get(key)!.add(n.symbol);
      }
    }
    if (noFreshDataSymbols.size > 0) {
      touch('NO_FRESH_DATA', date, [...noFreshDataSymbols],
        'News-catalyst ideas discarded for lack of fresh market data within the required window.');
    }
    for (const [key, symbols] of failureSymbols) {
      touch(key, date, [...symbols], `Decision-path failure category ${key.slice('FAILURE_'.length)} recurred across the week.`);
    }

    const auditSymbols = new Map<string, Set<string>>();
    for (const a of day.rejectedCandidateAudits) {
      const key = `AUDIT_${a.verdict}`;
      if (!auditSymbols.has(key)) auditSymbols.set(key, new Set());
      auditSymbols.get(key)!.add(a.symbol);
    }
    for (const [key, symbols] of auditSymbols) {
      touch(key, date, [...symbols], `Rejected-candidate audit verdict ${key.slice('AUDIT_'.length)} recurred across the week.`);
    }

    const universeSymbols = new Map<string, Set<string>>();
    for (const m of day.neverSeenMovers ?? []) {
      const key = `UNIVERSE_MISS_${normalizeCause(m.neverSeenCause)}`;
      if (!universeSymbols.has(key)) universeSymbols.set(key, new Set());
      universeSymbols.get(key)!.add(m.symbol);
    }
    for (const [key, symbols] of universeSymbols) {
      touch(key, date, [...symbols],
        `Market movers reconciled as NEVER_SEEN (cause ${key.slice('UNIVERSE_MISS_'.length)}) recurred across the week.`);
    }
  }

  const out: WeeklyDigestPattern[] = [];
  for (const [patternKey, a] of acc) {
    if (a.dates.size < minOccurrences) continue; // one-day anomalies stay one-day
    const dates = [...a.dates].sort();
    const symbols = [...a.symbols].sort().slice(0, maxSymbols);
    out.push({
      patternKey,
      occurrences: a.dates.size,
      symbols,
      dates,
      firstSeen: dates[0],
      lastSeen: dates[dates.length - 1],
      exampleEvidence: a.exampleEvidence,
    });
  }
  // Deterministic order: most recurring first, then alphabetical.
  out.sort((x, y) => y.occurrences - x.occurrences || (x.patternKey < y.patternKey ? -1 : 1));
  return out;
}
