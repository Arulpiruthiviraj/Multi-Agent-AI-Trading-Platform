# Implementation: Form 4 Scraper (2026-10-05)

## Status
IMPLEMENTED - data plumbing only. No signals, no votes, no trading.

## What was built
- `src/server/data/SecEdgarForm4Scraper.ts` - polls SEC EDGAR JSON API, parses Form 4 XML
- `insider_transactions` table (drizzle/0084)
- Gated by `ARGUS_SEC_EDGAR_FORM4_ENABLED` (default false)
- 4 unit tests on synthetic fixtures (parser logic, not market data)

## Design decisions
- JSON API over HTML scraping (stable, documented)
- Ticker->CIK via company_tickers.json, cached
- Scoped to Argus's idea universe, not all filers (bounded work)
- 500ms request spacing (far under SEC's 10/sec limit)
- Accession number dedupe (idempotent)

## What's NOT built
- Insider signal scoring (belongs in Java when designed)
- CEO/CFO purchase clustering
- Any consumption of this data by strategies

## Evidence boundary
Parser tests use synthetic XML fixtures. No real filings have been ingested yet
(flag defaults false). When enabled, ingested data is REAL SEC data, not synthetic.
