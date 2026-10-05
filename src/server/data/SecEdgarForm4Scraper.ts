/**
 * SecEdgarForm4Scraper.ts
 * ============================================================================
 * WHAT: Ingestion pipeline for SEC Form 4 insider-transaction filings.
 * WHERE IN THE ARCHITECTURE: This is the raw-data layer (Layer 0) of the
 *   alternative-data track. It sits entirely outside the trading spine:
 *
 *     SEC EDGAR API → [this scraper] → insider_transactions table
 *                                                   ↓ (future)
 *                                    InsiderSignalStrategy (Java quant core)
 *                                                   ↓ (future)
 *                                    InstitutionalStrategyVoteService → ChiefTrader
 *
 *   This module only fills the table. It never scores, ranks, or emits signals.
 *   That separation is deliberate: data ingestion and signal generation are
 *   different concerns with different failure modes and different testing needs.
 *
 * WHY FORM 4 (the quant case):
 *   Form 4 reports changes in beneficial ownership by corporate insiders
 *   (officers, directors, 10%+ holders). The academic literature (e.g.,
 *   Lakonishok & Lee 2001; Cohen, Malloy & Pomorski 2012) finds that insider
 *   open-market PURCHASES — particularly by CEOs/CFOs, particularly when
 *   clustered — predict positive abnormal forward returns. The mechanism is
 *   information asymmetry: insiders buy when they believe the market
 *   undervalues the firm, and they face real legal risk (Rule 10b-5) if they
 *   trade on material non-public information, so a purchase is a costly,
 *   credible signal.
 *
 *   Key properties that make Form 4 attractive as a data source:
 *   - TIMELINESS: must be filed within 2 business days of the transaction
 *     (Section 16(a), post-Sarbanes-Oxley). This is the fastest free
 *     fundamental signal available — faster than 13F (45 days), faster than
 *     earnings (quarterly).
 *   - COST: public domain (US government work product). Zero vendor cost,
 *     zero API key, zero contract. Compare: $20k+/yr for commercial insider
 *     feeds.
 *   - COVERAGE: every US-listed company with insiders. No survivorship bias
 *     in the source itself (though our symbol-universe filter introduces
 *     selection — see below).
 *
 *   What we do NOT assume: that every Form 4 predicts returns. Most insider
 *   sales are liquidity-driven (diversification, tax, option exercise) and
 *   carry little signal. The discriminating features — purchase vs. sale,
 *   officer title, cluster size, trade size relative to holdings — belong in
 *   the future Java scoring strategy, not in this ingestion layer.
 *
 * DESIGN DECISIONS (and why):
 *
 * 1. JSON API over HTML scraping.
 *    SEC EDGAR offers structured JSON at data.sec.gov (submissions API).
 *    HTML scraping (the /cgi-bin/browse-edgar pages) is brittle against
 *    layout changes and is explicitly discouraged by the SEC for bulk use.
 *    The JSON API is versioned, documented, and stable.
 *
 * 2. Scoped to Argus's idea universe, not all ~10,000 filers.
 *    A full-market sweep would be ~10k submissions-API calls per cycle plus
 *    XML fetches — unnecessary load on a free public service and unnecessary
 *    storage for symbols Argus never trades. resolveIdeaUniverse() gives us
 *    the symbols the strategy layer actually considers. This introduces a
 *    selection effect (we only see insider activity for our universe), which
 *    is acceptable because the downstream consumer only scores our universe.
 *
 * 3. Ticker → CIK via company_tickers.json, cached for process lifetime.
 *    EDGAR identifies filers by CIK (Central Index Key), not ticker. The
 *    mapping file is ~10k entries, changes rarely (only on new listings /
 *    ticker changes), and is cheap to fetch once. Caching avoids re-fetching
 *    a static file every 6-hour cycle.
 *
 * 4. Rate limiting: sequential requests, 500ms spacing (~2 req/sec).
 *    The SEC requires ≤10 req/sec and a descriptive User-Agent. We stay at
 *    ~20% of the limit. This is both polite (it's a free public service) and
 *    defensive (getting our IP throttled would silently starve the pipeline).
 *    If the universe grows large, the correct scaling is a longer cycle, not
 *    faster requests.
 *
 * 5. Idempotency via accession number.
 *    Every EDGAR filing has a unique accession number (e.g., 0000320193-26-000001).
 *    We strip dashes for the URL path but store the full form. The LIKE-prefix
 *    check (`accession + '%'`) catches both the filing-level row and the
 *    per-transaction suffixed rows (`{accession}#0`, `{accession}#1`, ...),
 *    so a re-scrape never duplicates. onConflictDoNothing() is belt-and-suspenders.
 *
 * 6. Bounded work per cycle: max 5 recent filings per symbol.
 *    The submissions API returns up to 1,000 recent filings per CIK. We only
 *    examine the 5 most recent because (a) older filings were either already
 *    ingested or are too stale to matter for a 2-day-filing-lag signal, and
 *    (b) unbounded XML fetching per symbol could turn one cycle into hours.
 *
 * 7. Fail-closed, never fail-loud.
 *    A scraper failure must never affect trading. Every network call is wrapped;
 *    per-symbol failures log and continue to the next symbol; a full-cycle
 *    failure logs and waits for the next cycle. The `running` guard prevents
 *    overlapping cycles if one runs long. There is deliberately no alerting
 *    escalation here — a missed 6-hour cycle just means slightly staler insider
 *    data, not a trading emergency.
 *
 * 8. Gated by ARGUS_SEC_EDGAR_FORM4_ENABLED (default false).
 *    Data ingestion is off until the operator explicitly enables it. This is
 *    consistent with Argus's "wide funnel, ruthless filter" principle: the
 *    funnel exists, but nothing flows until deliberately opened.
 *
 * TESTING NOTE:
 *   The parser (parseForm4Xml) is a pure function tested with synthetic
 *   fixtures — no network, no database. The network layer (secFetch,
 *   scrapeSymbol, scrapeOnce) is NOT unit-tested because it depends on the
 *   live SEC API; testing it would require either hitting the real API
 *   (flaky, impolite) or maintaining mock fixtures that drift from the real
 *   schema. The parser is where the logic lives; the network layer is thin.
 */

import { XMLParser } from 'fast-xml-parser';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { insiderTransactions } from '../db/schema';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { runtimeIntervals } from '../config/runtimeIntervals';

/**
 * A single insider transaction extracted from a Form 4 filing.
 *
 * Field semantics (from the Form 4 XML schema):
 * - transactionCode: SEC transaction code. 'P' = open-market purchase,
 *   'S' = open-market sale. Other codes: 'M' = option exercise, 'G' = gift,
 *   'A' = grant/award, 'D' = disposition to issuer, 'F' = tax withholding,
 *   'J' = other. Only P/S are open-market; the rest are compensation or
 *   transfer events with different (weaker) signal content.
 * - isDirect: 'D' (direct) vs 'I' (indirect, e.g., through a trust or spouse).
 *   Direct holdings are the insider's own economic exposure; indirect may
 *   reflect family/tax planning rather than conviction.
 * - sharesOwnedAfter: post-transaction holdings. The RATIO of transaction
 *   shares to holdings (not stored here, computable downstream) is often
 *   more informative than raw share count — a 10k-share purchase means
 *   something different for a CEO holding 1M shares vs. 15k shares.
 */
export interface Form4Transaction {
  accessionNumber: string;
  cik: string;
  ticker: string;
  filingDate: string;
  transactionDate: string | null;
  insiderName: string | null;
  insiderTitle: string | null;
  transactionCode: string | null;
  shares: number | null;
  pricePerShare: number | null;
  sharesOwnedAfter: number | null;
  isDirect: boolean | null;
}

// SEC requires a User-Agent identifying the requester with contact info.
// Without it, requests may be throttled or blocked. This is not optional.
const SEC_USER_AGENT = 'ArgusTrading research@argus.local';
// Static file mapping every EDGAR filer's ticker to their CIK. Updated by the
// SEC as listings change; we re-fetch on each process start (not each cycle).
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
// 500ms between requests = ~2 req/sec, 5x under the SEC's 10/sec ceiling.
// Chosen for politeness and throttle-avoidance, not throughput.
const REQUEST_SPACING_MS = 500;

// fast-xml-parser configuration for Form 4's ownershipDocument schema.
// Form 4 XML uses <value> wrapper elements for scalars:
//   <transactionShares><value>1000</value></transactionShares>
// We set ignoreAttributes:false because some elements carry attributes we
// might need later (e.g., footnotes), though we don't parse them today.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

/**
 * Thin wrapper around fetch for SEC EDGAR endpoints.
 *
 * Applies the mandatory User-Agent, a 30s timeout (EDGAR is usually fast;
 * a hang here would stall the entire sequential scrape loop), and converts
 * non-2xx responses to thrown errors (so the caller's try/catch handles them
 * uniformly rather than branching on status codes inline).
 */
async function secFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'application/json, application/xml, text/xml' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`SEC HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Ticker (uppercase) → zero-padded 10-digit CIK.
 *
 * Why zero-padded: EDGAR's submissions API requires the full 10-digit form
 * (e.g., CIK0000320193.json). The tickers file gives raw integers; padding
 * is our responsibility. Cached for the process lifetime because the mapping
 * changes only when companies list/delist/change tickers — far slower than
 * our 6-hour scrape cycle.
 */
let tickerCikCache: Map<string, string> | null = null;

export async function getTickerCikMap(): Promise<Map<string, string>> {
  if (tickerCikCache) return tickerCikCache;
  const text = await secFetch(SEC_TICKERS_URL);
  const data = JSON.parse(text) as Record<string, { cik_str: number; ticker: string }>;
  const map = new Map<string, string>();
  for (const entry of Object.values(data)) {
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, '0'));
  }
  tickerCikCache = map;
  return map;
}

/** For tests: reset the cache. */
export function resetTickerCikCacheForTests(): void {
  tickerCikCache = null;
}

/** For tests: inject a fake map without network. */
export function setTickerCikCacheForTests(map: Map<string, string>): void {
  tickerCikCache = map;
}

/**
 * Shape of the data.sec.gov submissions JSON.
 * We only declare the fields we use; the real response has more (addresses,
 * former names, exchanges, etc.) that we deliberately ignore.
 */
interface SubmissionsJson {
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
      primaryDocument: string[];
    };
  };
}

/**
 * Parse a Form 4 ownershipDocument XML string into transactions.
 *
 * This is a PURE function: no network, no database, no side effects.
 * That purity is what makes it unit-testable with synthetic fixtures.
 *
 * Form 4 XML structure (simplified):
 *   <ownershipDocument>
 *     <reportingOwner>           ← who filed (may repeat for joint filers;
 *       <reportingOwnerId>         we take the first)
 *         <rptOwnerName>
 *       <reportingOwnerRelationship>
 *         <officerTitle>           ← "Chief Executive Officer", etc.
 *     <nonDerivativeTable>       ← open-market + option transactions
 *       <nonDerivativeTransaction>  ← repeats per transaction
 *         <transactionDate><value>
 *         <transactionCoding><transactionCode>  ← P, S, M, G, ...
 *         <transactionAmounts>
 *           <transactionShares><value>
 *           <transactionPricePerShare><value>
 *         <postTransactionAmounts>
 *           <sharesOwnedFollowingTransaction><value>
 *         <ownershipNature>
 *           <directOrIndirectOwnership>  ← D or I
 *     <derivativeTable>          ← options/warrants (we IGNORE this)
 *
 * Deliberate omissions:
 * - derivativeTable: options exercises and grants have different economics
 *   from open-market trades. A future enhancement could parse them, but
 *   mixing them into the same transaction stream would confuse downstream
 *   scoring (an option exercise 'M' is not a conviction purchase).
 * - Footnotes: Form 4s often have footnotes explaining the transaction
 *   (e.g., "shares sold for tax withholding"). Parsing natural-language
 *   footnotes is an NLP task, out of scope for ingestion.
 * - Multiple reporting owners: joint filings list each owner; we attribute
 *   all transactions to the first listed owner. This is a simplification —
 *   the alternative (duplicating transactions per owner) would double-count.
 *
 * Returns an empty array (not null, not thrown) for malformed XML or filings
 * with no non-derivative transactions. The caller treats "no transactions"
 * and "unparseable" identically: nothing to store, move on.
 */
export function parseForm4Xml(
  xml: string,
  accessionNumber: string,
  cik: string,
  ticker: string,
  filingDate: string,
): Form4Transaction[] {
  const doc = xmlParser.parse(xml) as Record<string, unknown>;
  // Namespace prefix varies: some filings use <ownershipDocument>, others
  // use <:ownershipDocument> or a prefixed variant. Handle both.
  const ownership = (doc['ownershipDocument'] ?? doc[':ownershipDocument']) as Record<string, unknown> | undefined;
  if (!ownership || typeof ownership !== 'object') return [];

  const owner = ownership['reportingOwner'] as Record<string, unknown> | undefined;
  const ownerId = owner?.['reportingOwnerId'] as Record<string, unknown> | undefined;
  const insiderName = typeof ownerId?.['rptOwnerName'] === 'string' ? (ownerId['rptOwnerName'] as string) : null;
  const rel = owner?.['reportingOwnerRelationship'] as Record<string, unknown> | undefined;
  const insiderTitle = typeof rel?.['officerTitle'] === 'string' ? (rel['officerTitle'] as string) : null;

  const table = ownership['nonDerivativeTable'] as Record<string, unknown> | undefined;
  if (!table) return [];
  const txns = table['nonDerivativeTransaction'];
  // fast-xml-parser returns a single object (not an array) when there's only
  // one <nonDerivativeTransaction> element. Normalize to always iterate.
  const list = Array.isArray(txns) ? txns : txns ? [txns] : [];

  const out: Form4Transaction[] = [];
  // Form 4 wraps every scalar in <value> tags. This unwraps one level:
  // {value: "1000"} → "1000". Non-wrapped values pass through unchanged.
  const unwrap = (v: unknown): unknown => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as Record<string, unknown>)) {
      return (v as Record<string, unknown>)['value'];
    }
    return v;
  };
  for (const t of list as Record<string, unknown>[]) {
    const coding = t['transactionCoding'] as Record<string, unknown> | undefined;
    const amounts = t['transactionAmounts'] as Record<string, unknown> | undefined;
    const ownershipNature = t['ownershipNature'] as Record<string, unknown> | undefined;
    // Lenient numeric parsing: handles "1,000" (comma separators), plain
    // numbers, and numeric strings. Returns null (not NaN, not 0) for
    // anything unparseable — null means "unknown" downstream, while 0 would
    // mean "zero shares," which is a different (wrong) fact.
    const num = (v: unknown): number | null => {
      v = unwrap(v);
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const n = parseFloat(v.replace(/,/g, ''));
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };
    const str = (v: unknown): string | null => {
      v = unwrap(v);
      return typeof v === 'string' && v.length > 0 ? v : null;
    };
    out.push({
      // Suffix with the transaction index so each row has a unique PK even
      // when one filing contains multiple transactions. The base accession
      // number (before '#') is what the dedup LIKE-prefix matches on.
      accessionNumber: `${accessionNumber}#${out.length}`,
      cik,
      ticker,
      filingDate,
      transactionDate: str(t['transactionDate']),
      insiderName,
      insiderTitle,
      transactionCode: str(coding?.['transactionCode']),
      shares: num(amounts?.['transactionShares']),
      pricePerShare: num(amounts?.['transactionPricePerShare']),
      sharesOwnedAfter: num((t['postTransactionAmounts'] as Record<string, unknown> | undefined)?.['sharesOwnedFollowingTransaction']),
      isDirect: ownershipNature?.['directOrIndirectOwnership'] === 'D' ? true
        : ownershipNature?.['directOrIndirectOwnership'] === 'I' ? false : null,
    });
  }
  return out;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The scraper lifecycle manager.
 *
 * Runs as a background interval inside the Argus engine process (started from
 * ArgusCoreBoot, stopped by gracefulShutdown). It is NOT a separate process —
 * unlike the watchdog, which must survive engine death, this scraper dying
 * with the engine is fine (it just resumes on next boot; idempotent dedup
 * means no double-processing).
 *
 * Concurrency model: single-flight via the `running` flag. If a cycle takes
 * longer than the interval (large universe, slow SEC responses), the next
 * tick sees running=true and skips — no overlapping cycles, no thundering
 * herd against the SEC.
 */
class SecEdgarForm4Scraper {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  isEnabled(): boolean {
    return process.env.ARGUS_SEC_EDGAR_FORM4_ENABLED === 'true';
  }

  start(): void {
    if (this.intervalId || !this.isEnabled()) return;
    const ms = runtimeIntervals.secEdgarForm4Ms ?? 6 * 60 * 60 * 1000; // default 6h
    this.intervalId = setInterval(() => {
      void this.scrapeOnce().catch((e) => {
        observeSafe(() => structuredLogger.warn('form4_scrape_failed', {
          category: 'OBSERVABILITY', eventType: 'FORM4_SCRAPE_FAILED',
          error: e instanceof Error ? e.message : String(e),
        }));
      });
    }, ms);
    // Initial scrape 60s after boot (not immediately): lets the engine finish
    // its own startup (migrations, broker connect, model probes) before we
    // add network load. Not blocking — startup doesn't wait for us.
    setTimeout(() => {
      void this.scrapeOnce().catch(() => { /* logged inside */ });
    }, 60_000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * One full scrape cycle across the idea universe.
   *
   * Returns counts (not the data) so callers and logs can observe throughput
   * without holding transaction arrays in memory.
   *
   * Failure isolation: each symbol is wrapped in its own try/catch. A single
   * bad CIK, a malformed submissions JSON, or an SEC 500 for one symbol does
   * not abort the remaining symbols. This is important because the universe
   * can be hundreds of symbols; one bad apple shouldn't starve the rest.
   */
  async scrapeOnce(): Promise<{ symbols: number; filings: number; transactions: number }> {
    if (this.running) return { symbols: 0, filings: 0, transactions: 0 };
    this.running = true;
    try {
      const universe = resolveIdeaUniverse();
      const cikMap = await getTickerCikMap();
      let filings = 0;
      let transactions = 0;
      for (const symbol of universe) {
        const cik = cikMap.get(symbol.toUpperCase());
        // No CIK = not an EDGAR filer (e.g., crypto, forex, or a ticker
        // variant the SEC file doesn't recognize). Skip silently — this is
        // expected for non-equity symbols, not an error.
        if (!cik) continue;
        try {
          const r = await this.scrapeSymbol(symbol, cik);
          filings += r.filings;
          transactions += r.transactions;
        } catch (e) {
          observeSafe(() => structuredLogger.warn('form4_symbol_failed', {
            category: 'OBSERVABILITY', eventType: 'FORM4_SYMBOL_FAILED', symbol,
            error: e instanceof Error ? e.message : String(e),
          }));
        }
        await sleep(REQUEST_SPACING_MS);
      }
      return { symbols: universe.length, filings, transactions };
    } finally {
      this.running = false;
    }
  }

  /**
   * Scrape one symbol's recent Form 4 filings.
   *
   * Flow per symbol:
   *   1. Fetch submissions JSON (lists recent filings with form types)
   *   2. Filter to form '4', take the 5 most recent
   *   3. For each: skip if already stored (dedup), else fetch XML → parse → insert
   *
   * The accession number in the submissions JSON contains dashes
   * (0000320193-26-000001); the archive URL requires them stripped.
   * We store the stripped form and match dedup on its prefix.
   */
  private async scrapeSymbol(symbol: string, cik: string): Promise<{ filings: number; transactions: number }> {
    const submissionsText = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const submissions = JSON.parse(submissionsText) as SubmissionsJson;
    const recent = submissions.filings?.recent;
    if (!recent) return { filings: 0, transactions: 0 };

    let filings = 0;
    let transactions = 0;
    // Bounded: only the 5 most recent filings. Rationale in the header comment.
    for (let i = 0; i < Math.min(5, recent.form.length); i++) {
      if (recent.form[i] !== '4') continue;
      const accession = recent.accessionNumber[i].replace(/-/g, '');
      const filingDate = recent.filingDate[i];
      // Dedup: LIKE-prefix matches both the base accession and any
      // suffixed per-transaction rows from a prior ingest. One indexed
      // lookup per filing — cheap, and it avoids a wasteful XML fetch.
      const existing = db.select().from(insiderTransactions)
        .where(sql`${insiderTransactions.accessionNumber} LIKE ${accession + '%'}`).limit(1).all();
      if (existing.length > 0) continue;
      // EDGAR archive URL pattern: /Archives/edgar/data/{CIK-as-int}/{accession-no-dashes}/{primary-doc}
      // Note: CIK in the path is the integer form (no leading zeros, no "CIK" prefix).
      const docUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accession}/${recent.primaryDocument[i]}`;
      const xml = await secFetch(docUrl);
      const txns = parseForm4Xml(xml, accession, cik, symbol, filingDate);
      const now = new Date().toISOString();
      for (const t of txns) {
        db.insert(insiderTransactions).values({
          accessionNumber: t.accessionNumber,
          cik: t.cik,
          ticker: t.ticker,
          filingDate: t.filingDate,
          transactionDate: t.transactionDate,
          insiderName: t.insiderName,
          insiderTitle: t.insiderTitle,
          transactionCode: t.transactionCode,
          shares: t.shares,
          pricePerShare: t.pricePerShare,
          sharesOwnedAfter: t.sharesOwnedAfter,
          isDirect: t.isDirect === null ? null : (t.isDirect ? 1 : 0),
          createdAt: now,
        }).onConflictDoNothing().run();
      }
      filings += 1;
      transactions += txns.length;
      await sleep(REQUEST_SPACING_MS);
    }
    observeSafe(() => structuredLogger.info('form4_symbol_scraped', {
      category: 'OBSERVABILITY', eventType: 'FORM4_SYMBOL_SCRAPED', symbol, filings, transactions,
    }));
    return { filings, transactions };
  }
}

export const secEdgarForm4Scraper = new SecEdgarForm4Scraper();
