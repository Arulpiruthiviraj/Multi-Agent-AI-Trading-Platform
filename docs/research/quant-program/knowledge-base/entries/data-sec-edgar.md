---
kind: data
family: alternative-data
status: RESEARCHED
argus_status: MISSING_MEDIUM
argus_refs: []
sources:
  - { title: "SEC EDGAR Full-Text Search API", authors: "U.S. Securities and Exchange Commission", year: 2026, url: "https://www.sec.gov/cgi-bin/browse-edgar", license: "public domain (US government)" }
  - { title: "Free Historical Insider Trading and Institutional Holdings Data", authors: "Austin Starks (NexusTrade)", year: 2026, url: "https://nexustrade.io/blog/free-historical-insider-and-institutional-stock-data-20261003", license: "article (free data offering)" }
evidence_quality: 70
data_requirements: [alternative]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- VERIFIED FACT: SEC EDGAR is free, public-domain, with a JSON API: submissions at `https://data.sec.gov/submissions/CIK{cik}.json`, structured financials (XBRL) at `https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json`, full-text search at `https://efts.sec.gov/LATEST/`. Rate limit: 10 req/sec, requires User-Agent header.
- VERIFIED FACT: Form 4 (insider transactions) must be filed within 2 business days — the fastest free fundamental signal available. 8-K Item 2.02 carries earnings releases within 4 business days. 13F (institutional holdings) lags ~45 days.
- RESEARCH FINDING: Insider buying (especially CEO/CFO open-market purchases) has published predictive power for forward returns; the academic evidence is stronger for purchases than sales (sales are often diversification, not information).
- INFERENCE: EDGAR is the cheapest high-value data upgrade available to Argus: zero cost, no vendor, legal, and it unlocks both the PEAD research card (8-K earnings pipeline) and an insider-signal family.
- HYPOTHESIS: A Form 4 clustering signal (multiple insiders buying within a window) is more robust than single-insider signals.

## Mathematics
Insider signal (example specification): for symbol s, window W=30d: I_s = Σ w_i · 1{buy} − Σ w_j · 1{sell}, where w weights by insider rank (CEO/CFO > director > officer) and dollar size. Normalize cross-sectionally: z_s = (I_s − μ)/σ. Enter on z_s > 2.
Earnings surprise: S = (actual_EPS − consensus_EPS)/σ(analyst dispersion), from 8-K Item 2.02 vs consensus feed. PEAD: hold S > 1 for 60 trading days post-announcement (Bernard-Thomas 1989).

## Economic rationale
Information asymmetry: insiders trade on non-public operational knowledge; their purchases are a costly signal (they risk their own capital). PEAD: market underreacts to earnings news (behavioral) — one of the most replicated anomalies in finance.

## Argus mapping
MISSING_MEDIUM. Argus has FundamentalAgent (AlphaVantage) and NewsEngine (RSS) but no SEC ingestion. The PEAD research card is gated on "unverified point-in-time earnings feed" — EDGAR 8-K monitoring resolves the *timing* half (when earnings hit); consensus estimates still need a vendor (Zacks/IBES) or a scraped calendar.

## Failure modes
EDGAR parsing brittleness (filing formats vary; needs self-healing parsers); 13F staleness (45-day lag — use only for slow-moving institutional ownership features, never timing); insider sales are noisy (exclude or downweight); small-cap insiders trade less (coverage bias).

## Verdict
PROMOTE to data-infrastructure queue. Phase 1: Form 4 scraper (simplest, highest signal-per-effort). Phase 2: 8-K Item 2.02 earnings monitor (unlocks PEAD). Phase 3: 13F institutional ownership features. All in a new Java or TS ingestion module — data plumbing, not quant math, so TS is acceptable per the Java Authority carve-outs.
