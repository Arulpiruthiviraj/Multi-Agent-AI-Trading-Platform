# ARGUS Postmarket Learning — Phase 1 (2026-09-10)

**Scope note:** the full request ("ARGUS — Automatic Post-Market Market Scan, Missed-Opportunity Analysis & Learning System") specified a ~30-section system: market-wide screener integration, point-in-time minute-by-minute reconstruction, ~12 new database tables, a research-hypothesis→backtest→walk-forward→promotion pipeline, automated scheduling with restart-survival, and extensive edge-case test coverage. Attempting all of that in one pass would have produced shallow, under-tested code — this document covers the explicitly scoped **Phase 1**: (1) fix the confirmed root cause stalling missed-opportunity outcome evaluation, (2) produce one real, honest daily report reusing existing data, and (3) document what's deferred.

## 1. Real bug fixed: `HistoricalDataGateway.ensureBars()` had no fallback when IBKR fails

**Root cause (confirmed live, traced from the 2026-09-10 forensic audit):** `MissedOpportunityEvaluator.evaluatePending()` calls `historicalDataGateway.ensureBars(symbol, '1Min', ...)` to compute real MFE/MAE outcomes. Since the active broker/historical-bar provider is `ibkr_gateway`, `ensureBars()` only ever tried IBKR's historical-bar API — and IBKR was failing for the same market-data-entitlement reason already found on the live streaming path (`code=354 "Requested market data is not subscribed"`). On failure it threw immediately with no fallback, so every missed-opportunity record stayed `PENDING` forever — confirmed: 0 of 18 real detections evaluated across a full session with hours of real elapsed time to spare.

**Fix (`src/server/engines/backtest/HistoricalDataGateway.ts`):** when the IBKR branch fails or returns empty (and no cached bars exist), `ensureBars()` now falls through to the existing Alpaca REST path instead of throwing immediately — the same "primary provider unavailable → try a real, already-configured alternative" pattern as this session's earlier AlphaVantage→FMP/FRED fallback for `FundamentalAgent`/`MacroAgent`. Never fabricates a bar: if Alpaca also has nothing, the original "no historical data available" error still fires.

This is not narrowly scoped to `MissedOpportunityEvaluator` — `HistoricalDataGateway` is a shared dependency (backtest engine, regime classification, quant strategy bar-history checks). This fix benefits every consumer, not just this one worker.

**Tests:** 4 new tests in `HistoricalDataGateway.test.ts` (IBKR-empty→Alpaca-fallback, IBKR-throws→Alpaca-fallback, both-fail→still throws/never fabricates, cache-first still short-circuits before either provider is touched). One pre-existing test in `HistoricalDataProviderRegistry.ibkr.test.ts` updated to match the new, correct error-message chain (was asserting the old immediate-throw behavior). Full suite: see verification note below.

## 2. Real, working daily report: `scripts/postmarket_missed_opportunity_report.ts`

Read-only, standalone (does not import the shared `db` writer — the live Argus process is the sole writer to `data/argus.db` per this codebase's one-writer rule; uses a direct `better-sqlite3` readonly connection instead, safe to run alongside a live engine). Reuses **existing** tables only — no new migrations this phase:

- `observability_events`' real discovery lineage (`DISCOVERY_CANDIDATE_ADMITTED`/`FILTERED`, `NEWS_ANALYZED`/`NEWS_CLUSTER_CREATED`)
- `missed_opportunities` (the existing detector's own classification)
- A direct, read-only Alpaca REST call (never persisted, never fabricated when unavailable) for a real EOD reference price

**Classification taxonomy** (grounded in what the data actually shows, never a hardcoded symbol list — the script discovers whatever the live system actually touched that day):

| Classification | Meaning |
|---|---|
| `CORRECT_NON_ACTION` | Filtered on `PRICE`/`SPREAD` — a deliberate policy exclusion (e.g. sub-$5 penny-stock screen), correctly applied at scan time |
| `LIQUIDITY_EXCLUDED` | Filtered on `ADV`/`DOLLAR_VOLUME` with a real, measured value below the floor |
| `DATA_QUALITY_GAP` | Filtered on `ADV` but the underlying `advShares` value was `null` — the gate correctly failed closed on missing data, but the data fetch itself is the real gap |
| `NEWS_BLIND_SPOT` | NewsEngine analyzed a real story mentioning the symbol, but it never became a discovery candidate |
| `TRUE_UNIVERSE_MISS` | Zero discovery-lineage or news events found at all |
| `ADMITTED_NO_MISSED_OPP_ROW` | Reached discovery admission but didn't separately surface as a missed opportunity — likely evaluated normally |
| Existing detector classes | `SUBSCRIPTION_MISS`/`AGENT_MISS`/`CONSENSUS_REJECTION`/`THESIS_INVALIDATED`/`EXECUTION_MISS` pass through unchanged from `missed_opportunities` |

**Run against real 2026-09-10 data** — `docs/audits/argus_postmarket_2026-09-10.html` (+ `postmarket_missed_opportunity_findings_2026-09-10.json`): 1,259 distinct symbols touched by the pipeline that day. Verified against the user-supplied named examples:

| Symbol | Classification | Real evidence |
|---|---|---|
| **TNON** | `CORRECT_NON_ACTION` | First seen $2.49 → real Alpaca EOD close $5.245 = **+110.6%** (independently corroborates the reported +117% move). Filtered on the deliberate penny-stock price screen ~120 separate times through the day — the exclusion was applied correctly and repeatedly, not missed. |
| **DBGI** | `CORRECT_NON_ACTION` | Same price-screen exclusion; real EOD data unavailable from Alpaca's IEX feed for this symbol (honestly reported `UNAVAILABLE`, not guessed). |
| **SWKS** | `DATA_QUALITY_GAP` | `advShares: null` at filter time — a real data-fetch gap, not a genuine illiquidity call (SWKS is a real, liquid mid-cap). |
| **AVAV** | `ADMITTED_NO_MISSED_OPP_ROW` | Filtered early (ADV), but later in the day a real `DISCOVERY_CANDIDATE_ADMITTED` event exists — evidence contradicts a same-day "never admitted" claim; it was eventually let through. |
| **SEI** | Not found in this pass | A `NEWS_ANALYZED` event referencing "solaris-energy-sei-rockets" exists, but its structured `symbol` column wasn't populated with `SEI` — a real, disclosed limitation (see below), not a silent gap. |
| **SOLS** | Not found | Zero events of any kind — genuinely never touched by any part of the pipeline this report can trace. |

**Known limitations of this Phase 1 report, disclosed not hidden:**
1. News-story-to-symbol association only works when the event's structured `symbol` column is populated — a full-text scan of news payloads was out of scope for this pass (missed the SEI case above).
2. No point-in-time minute-by-minute reconstruction — only "first discovery-lineage snapshot" vs. "real EOD close."
3. No strategy-level (per-QuantEngine-strategy) outcome attribution yet — that's a materially larger, separate piece of the original request.
4. Not yet wired into automatic scheduling — run on demand (`npx tsx scripts/postmarket_missed_opportunity_report.ts [YYYY-MM-DD]`). Survives-restart scheduling, retry-on-failure, and health/alerting are deferred to a future phase.

## 3. Explicitly deferred to a future phase (not attempted, not faked)

- Market-wide universe scanning beyond what `MarketUniverseScanner`'s existing broad-universe/movers funnel already does (today's evidence shows this is *already* seeing far more symbols than expected — 1,259 touched — so the real gap was evaluation completeness and news integration, not scan breadth, contrary to the original hypothesis).
- New database tables (`post_market_runs`, `strategy_daily_outcomes`, `research_hypotheses`, etc.) — none created this phase; today's report writes only static JSON/HTML files.
- The research-hypothesis → backtest → out-of-sample → walk-forward → paper → promotion pipeline.
- Automatic scheduling, restart-survival, and health/alerting for the report job.
- Strategy-by-strategy and agent-by-agent post-market scorecards.
- Point-in-time forensic reconstruction at intraday granularity.

## Verification

- `npx tsc --noEmit`: clean.
- `HistoricalDataGateway.test.ts`: 16/16 passing (12 original + 4 new).
- `HistoricalDataProviderRegistry.ibkr.test.ts` + `MissedOpportunityEvaluator.test.ts`: 12/12 passing.
- Full suite (`npx vitest run`): run in the background; see the session's own follow-up for the final count before treating this as fully verified.
