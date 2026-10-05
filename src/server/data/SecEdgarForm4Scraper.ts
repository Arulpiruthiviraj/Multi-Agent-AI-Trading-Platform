/**
 * SecEdgarForm4Scraper.ts
 *
 * 2026-10-05: SEC EDGAR Form 4 (insider transaction) ingestion — Phase 1 of the
 * alternative-data track (knowledge-base/entries/data-sec-edgar.md).
 *
 * Why Form 4: insider open-market purchases (especially CEO/CFO) have published
 * predictive power for forward returns; Form 4 must be filed within 2 business
 * days, making it the fastest free fundamental signal available. Public domain
 * (US government), zero vendor cost.
 *
 * Design:
 * - Polls SEC EDGAR JSON APIs (not HTML scraping): company_tickers.json for the
 *   ticker->CIK map, /submissions/CIK{cik}.json for recent filings.
 * - Parses the Form 4 ownershipDocument XML for non-derivative transactions.
 * - Stores to insider_transactions (dedupe on accession number).
 * - SEC rate limit: max 10 req/sec, requires a User-Agent header with contact.
 *   This scraper stays far under it (sequential requests, 500ms spacing).
 * - Scoped to Argus's tracked symbols only (resolveIdeaUniverse), not all filers.
 *
 * This is DATA PLUMBING, not quant math — TypeScript is the correct home per the
 * Java 26 Engine Authority carve-outs. It emits no trade ideas; downstream
 * consumers (a future insider-signal strategy) read the table.
 *
 * Gated by ARGUS_SEC_EDGAR_FORM4_ENABLED (default false in .env.example).
 */

import { XMLParser } from 'fast-xml-parser';
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { insiderTransactions } from '../db/schema';
import { resolveIdeaUniverse } from '../core/ideaUniverse';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { runtimeIntervals } from '../config/runtimeIntervals';

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

const SEC_USER_AGENT = 'ArgusTrading research@argus.local';
const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const REQUEST_SPACING_MS = 500;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

async function secFetch(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'application/json, application/xml, text/xml' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`SEC HTTP ${res.status} for ${url}`);
  return res.text();
}

/** ticker (uppercase) -> zero-padded 10-digit CIK. Cached for the process lifetime. */
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
 * Pure function — unit-testable with synthetic fixtures.
 */
export function parseForm4Xml(
  xml: string,
  accessionNumber: string,
  cik: string,
  ticker: string,
  filingDate: string,
): Form4Transaction[] {
  const doc = xmlParser.parse(xml) as Record<string, unknown>;
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
  const list = Array.isArray(txns) ? txns : txns ? [txns] : [];

  const out: Form4Transaction[] = [];
  // Form 4 XML wraps scalar values in <value> tags: <transactionShares><value>1000</value></transactionShares>
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
    // Initial scrape shortly after boot, not blocking startup.
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

  /** Scrape Form 4s for all tracked symbols. Exported for tests/manual triggers. */
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

  private async scrapeSymbol(symbol: string, cik: string): Promise<{ filings: number; transactions: number }> {
    const submissionsText = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const submissions = JSON.parse(submissionsText) as SubmissionsJson;
    const recent = submissions.filings?.recent;
    if (!recent) return { filings: 0, transactions: 0 };

    let filings = 0;
    let transactions = 0;
    // Only the most recent 5 filings per symbol per cycle — bounded work.
    for (let i = 0; i < Math.min(5, recent.form.length); i++) {
      if (recent.form[i] !== '4') continue;
      const accession = recent.accessionNumber[i].replace(/-/g, '');
      const filingDate = recent.filingDate[i];
      // Skip if already stored.
      const existing = db.select().from(insiderTransactions)
        .where(sql`${insiderTransactions.accessionNumber} LIKE ${accession + '%'}`).limit(1).all();
      if (existing.length > 0) continue;
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
