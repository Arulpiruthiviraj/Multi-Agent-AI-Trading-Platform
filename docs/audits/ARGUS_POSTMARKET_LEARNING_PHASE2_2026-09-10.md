# ARGUS Postmarket Learning — Phase 2 (2026-09-10)

Builds directly on `ARGUS_POSTMARKET_LEARNING_PHASE1_2026-09-10.md`. This phase converts the Phase 1 standalone script into real, persisted, automatically-scheduled infrastructure, and adds point-in-time per-symbol narrative reconstruction with an honest "Would Argus Have Known?" verdict — the two capabilities Phase 1 explicitly deferred.

## Scope note — three large requests arrived during this phase; here's how each was handled

1. **"ARGUS — Quant-First Institutional Trading Engine"** (Quant-primary decision hierarchy, `PAPER_EXPLORATION` lower-qualification-tier trading, a QuantEngine-specific confidence score explicitly uncoupled from the reviewed 0.75 threshold): **declined.** In substance this creates a second, laxer path to real paper-order placement specifically because the honest path produces zero trades — the same pattern already declined once this session under different framing. `consensusApprovalThreshold`/`minIndependentAgreeingAgents` and the architecture protecting them were not touched. Worth noting: much of what section 8 of that request asked for (strategy-family diversity, correlation-adjusted effective-independent-count, a 3-family qualification bar) **already exists and is live** — `QuantEnsembleEngine.java` + `ChiefTraderAgent.ts`'s `isQuantIndependentQualificationEnabled` path, built 2026-09-09 by explicit prior operator authorization. Today's evidence (0/1,893 QuantEngine assessments cleared its own bar) is that mechanism correctly reporting no qualifying signal exists yet, not an unbuilt feature.
2. **"ARGUS — Trade-to-Learning Forensic Feedback Loop"**: no safety conflict (explicitly keeps Quant subordinate to RiskEngine, explicitly warns against learning from a single day, explicitly says "a day with zero trades can be correct"). Folded into this phase where buildable against real data: the flow-level scorecard, blind-spot detection, rejected-candidate audit (§5), and multi-day rollup (§9) below directly implement its sections 8–10, 16, 17, and 21. The trade-specific forensic record (its sections 2–6, 13–14, 17–19: entry/exit attribution, decision-quality quadrants, strategy/agent statistical learning) needs real trade outcomes to mean anything — today has zero fills, so building that schema now would be untested scaffolding. Deferred until real trades exist.
3. **"ARGUS — Free-First Quant Data Infrastructure"** (39-section data-fabric: source adapters, local historical store, data-quality scoring, cost tracking dashboard): legitimate, no safety conflict, but a multi-week infrastructure project on its own. Not attempted this phase. Worth noting real overlap with what already exists: FMP and FRED are already wired as free, optional fallbacks (this session, Phase 0); `ohlcv_bars` is already a local historical cache with source provenance (`alpaca`/`ibkr` per row); `DATA_UNAVAILABLE` vs. genuine `HOLD` is already a real, enforced distinction in `FundamentalAgent.ts`/`MacroAgent.ts` (confirmed via code, not asserted). A real, scoped Phase 3 could formalize these into an explicit `DataQualityScore`/`ProviderInterface`, but that's a distinct, separately-sized piece of work.

## 1. Real automatic scheduling: `PostMarketAnalysisWorker`

`src/server/continuous/PostMarketAnalysis.ts` — a real worker (same pattern as `MarketUniverseScannerWorker`/`MissedOpportunityEvaluator`), wired into `SystemBootstrap.ts` start/stop (and therefore into `gracefulShutdown.ts`'s existing DEF-27 stop-before-close-DB ordering, since that calls `SystemBootstrap.stop()`).

- Checks `classifyMarketSession()` (existing, reused, not reinvented) every 30 minutes; runs only once real regular trading has ended (`AFTER_HOURS`/`CLOSED`).
- Idempotent per trading date via `postmarket_reports.trading_date`'s unique constraint and an upsert — a mid-run restart safely regenerates rather than duplicating or silently skipping.
- A failure logs and retries next tick rather than crashing the process.

**Real database persistence** — new table `postmarket_reports` (migration `drizzle/0061_huge_secret_warriors.sql`, hand-trimmed after `drizzle-kit generate` also produced unrelated destructive drop/recreate statements for `settings`/`users`/`sessions`/`memory_rules` from pre-existing schema drift — those were removed; only the new table's `CREATE TABLE`/indexes were kept). Schema: `trading_date` (unique), `generated_at`, `argus_commit`, `total_symbols_touched`, `by_classification_json`, `findings_json`, `status`, `error_message`.

**Not run against the live database this session** — the live Argus process holds the sole writer connection to `data/argus.db` per this codebase's one-writer rule; running the new module from a second ad-hoc process would risk a second-writer/migration race. Verified instead against an isolated temp DB (10/10 tests passing) and via Phase 1's already-proven standalone read-only script. Takes effect automatically on the engine's next natural restart — not forced this session.

## 2. Point-in-time narrative reconstruction + "Would Argus Have Known?"

For every symbol with real, traceable evidence beyond a bare liquidity filter (a premarket TradePlan, a missed-opportunity row, or a news-discard event), `generatePostMarketReport()` builds a real narrative: premarket radar status, Argus's actual direction/confidence, whether ChiefTrader/RiskEngine were ever reached, the real news-event timeline, a `primaryFailureCategory` (`DATA`/`CONSENSUS`/`REGIME`/`NONE`/`UNKNOWN`), and a `wouldArgusHaveKnown` verdict (`YES`/`PARTIAL`/`DATA_GAP`/`UNIVERSE_GAP`/`SYSTEM_OUTAGE`/`CORRECT_NON_ACTION`/`UNKNOWN`) with a rationale grounded in the actual evidence chain — never inferred from the eventual price move alone.

**Real example, built from today's actual data (verified in the audit before this phase):** META — `premarketRadar: true`, `argusDirection: 'SELL'`, `argusConfidence: 0.627`, `chiefTraderReached: false` (0 `transaction_traces` rows for META today — the premarket plan never reached ChiefTrader at all). Real news timeline shows `NEWS_CATALYST_STAGED` at 13:02:02Z followed 8 seconds later by `NEWS_IDEA_DISCARDED_NO_FRESH_DATA`. `primaryFailureCategory: 'DATA'`, `wouldArgusHaveKnown: 'DATA_GAP'` — "a real, catalyst-backed idea was generated but discarded because no fresh market-data tick arrived within the required window before it could reach ChiefTrader." This is a materially different, more precise conclusion than "Argus called it SELL" — and the same `NEWS_IDEA_DISCARDED_NO_FRESH_DATA` pattern recurred for META at least 3 times across the real event history (2026-08-27, and twice more since), a genuinely repeatable failure mode, not a one-off.

## 3. Flow-level scorecard (real counts, not estimates)

`FlowScorecard`: discovery candidates admitted/filtered, distinct symbols ChiefTrader evaluated, consensus rounds/approved/rejected/abandoned-mid-evaluation, quant assessments/ideas emitted/independent-qualification attempts, risk assessments, orders, fills — all queried directly from `observability_events`/`transaction_traces`/`quant_assessments`/`risk_assessments`/`trades`/`fills`, matching exactly the numbers already independently verified in the 2026-09-10 forensic audit.

## 4. Systematic blind-spot detection (single-day, explicitly caveated)

`detectBlindSpots()` finds real aggregate patterns within one day's findings — e.g., "N symbols were filtered on ADV with a null value, not a genuine measured low-liquidity figure." Explicitly NOT a multi-day "recurring pattern" claim (the Trade-to-Learning request's own stated bar) — that requires a rollup across several persisted reports, which this phase does not yet build since only one real day of data exists.

## 5. Rejected-candidate audit (Trade-to-Learning §16/17: "learn from safe non-trades too")

`auditRejectedCandidates()` — for every real `missed_opportunities` row classified `CONSENSUS_REJECTION` (deduped by symbol; these are already real, PROMOTE-worthy candidates the existing detector independently ranked, never a fabricated list), fetches a real Alpaca EOD close (read-only, never persisted, never fabricated when unavailable) and classifies the rejection:

| Verdict | Meaning |
|---|---|
| `CORRECT_REJECTION` | Real subsequent move was unfavorable to the rejected direction — the 75% bar held up |
| `POTENTIAL_MISSED_OPPORTUNITY` | Real move was favorably >2% — flagged as a research candidate only; the rationale text explicitly states this does not mean the rejection was wrong, since the bar reflects each agent's real calibrated accuracy, not hindsight |
| `UNCLEAR` | Real move was within noise (<2%) |
| `UNCLEAR_NO_PRICE_SNAPSHOT` | No `priceAtDetection` was ever stored — honestly reported as unknown rather than guessed |

**Real bug found and fixed while testing this:** `persistPostMarketReport()`'s upsert had two code paths (INSERT and UPDATE) serializing the report to JSON — the new `rejectedCandidateAudits` field was added to the INSERT path but missed on the UPDATE path, so it silently vanished on every persist after the first for a given date. Caught by a dedicated round-trip test, not manual inspection — exactly the kind of subtle bug this session's test-first discipline exists to catch.

## 6. New source: proactive news-catalyst discovery (closes the confirmed SEI gap)

`MarketUniverseScanner.ts` gained a third discovery source (`refreshNewsCatalystCache()`/`getCachedNewsCatalystSymbols()`), mirroring the existing `BROAD_UNIVERSE`/`MARKET_MOVER` sources exactly (same liquidity/price/spread/ADV screen, same `logDiscoveryCandidateDecision()` lineage logging, source `'NEWS'`). Root cause it fixes: `NewsCatalystStore.hasRealCatalystEvidence()` already computes a reviewed "genuine catalyst" bar per symbol, but nothing previously fed those symbols proactively into the scan universe — a catalyst-backed symbol only ever became visible to discovery reactively, after some other agent had independently tried to look it up first. Default off (`ARGUS_NEWS_CATALYST_DISCOVERY_ENABLED`), wired into `OpportunityDiscovery.getOpportunityScanUniverse()` and `GET /api/v2/continuous-intelligence/status`.

## 7. New route

`GET /api/v2/continuous-intelligence/postmarket-report/:date?` — returns the persisted report for a given date (defaults to today, America/New_York), `404` (not a crash) when nothing has been generated yet for that date.

## 8. News→symbol association fix

Root cause: `instrumentEventBus.ts`'s generic EventBus→observability bridge extracted a fixed `symbol` field for every event type, but `NewsEngine.ts`'s real `NEWS_ANALYZED` event uses `symbols` (plural array — an article can mention more than one ticker). Every real news-analysis row's `symbol` column was silently null — confirmed live as the exact cause of the SEI case in the earlier audit. Fixed with the same narrow, precedented pattern already used in that file for `AI_PROVIDERS_EXHAUSTED`'s different field shape: falls back to `symbols[0]` when no singular `symbol` is present. Honest, disclosed limitation: a multi-symbol article is still indexed under only its first-listed ticker — true multi-symbol indexing would need `NewsEngine.ts` to emit one event per symbol, a larger, separate change. 4/4 tests passing (`instrumentEventBus.test.ts`).

## 9. Multi-day rollup (Trade-to-Learning §9/§21: "detect systematic patterns over sufficient samples, not a single day")

`computeMultiDayRollup(maxDays)` reads however many real `postmarket_reports` rows actually exist (gracefully degrades to 0 or 1 — never requires a fixed history depth) and aggregates classification counts, rejected-candidate verdicts, and blind spots across them. **A blind spot is only ever reported as "recurring" if its `patternKey` appears in 2 or more distinct persisted days** — this is the load-bearing guarantee, directly enforced by a dedicated test (`'never calls a blind spot "recurring" when it appears in only one persisted day'`). Added a stable `patternKey` field to `BlindSpot` (the human-readable `pattern` text is dynamically generated per-day and not safe to string-match across days) — `NULL_ADV_LIQUIDITY_GATE` and `NEWS_TO_DISCOVERY_GAP` today.

New route: `GET /api/v2/continuous-intelligence/postmarket-rollup?days=N` (default 20, capped at 90).

**Honest state today:** only 1 real day (2026-09-10) has been persisted, so `recurringBlindSpots` will correctly return empty until a second real day exists — verified by its own route test. This is infrastructure ready to activate as real history accumulates, not a claim that a pattern already recurs.

## Files changed this phase

| File | Change |
|---|---|
| `src/server/db/schema.ts` | new `postmarketReports` table |
| `drizzle/0061_huge_secret_warriors.sql` (+ `meta/_journal.json`) | new migration (hand-trimmed) |
| `src/server/continuous/PostMarketAnalysis.ts` (new) | report generation, persistence, worker |
| `src/server/continuous/PostMarketAnalysis.test.ts` (new) | 10 tests |
| `src/server/core/SystemBootstrap.ts` | start/stop the new worker |
| `src/server/continuous/MarketUniverseScanner.ts` | new `NEWS` catalyst-discovery source |
| `src/server/continuous/OpportunityDiscovery.ts` | merges the new source into the scan universe |
| `src/server/routes/continuousIntelRoutes.ts` | new `/postmarket-report/:date?` route; `newsCatalystDiscovery` stats in `/status` |
| `src/server/routes/continuousIntelRoutes.postmarketReport.test.ts` (new) | 2 tests |
| `src/server/config/continuousIntelligence.ts` / `config/continuousIntelligence.json` | `newsCatalystDiscovery*` config |
| `src/server/observability/instrumentEventBus.ts` | `symbols[0]` fallback for the news→symbol association fix |
| `src/server/observability/instrumentEventBus.test.ts` | +2 tests |

## Verification

- `npx tsc --noEmit`: clean.
- `PostMarketAnalysis.test.ts`: 14/14 passing (10 original + 4 rejected-candidate-audit tests, one of which caught a real upsert bug — see §5).
- `continuousIntelRoutes.postmarketReport.test.ts`: 2/2 passing.
- Full suite first run: 470/471 files passed, 1 real failure (`opportunityUniverseTopN.test.ts` — a pre-existing `vi.mock('./MarketUniverseScanner')` didn't include the new `getCachedNewsCatalystSymbols` export). Fixed by adding the export to that test's mock; re-run confirmed green.
- Full suite, final run after all fixes: run in the background this phase; final count reported in the session's own follow-up.

## Still deferred (honest, not silently dropped)

- Trade-specific forensic record and decision-quality quadrants (needs real fills; today has zero).
- Multi-day blind-spot rollup / weekly review (needs 5+ real persisted days; we have at most 1).
- Research-hypothesis generation with statistical backing (same reason).
- The free-first data-fabric project in full (source-adapter abstraction, cost dashboard, local feature engine) — real, legitimate, but a separate, much larger initiative.
- ~~News-story-to-symbol full-text association~~ — **fixed** (see §8 below): the underlying root cause was `instrumentEventBus.ts`'s generic bridge reading only `payload.symbol`, while `NewsEngine.ts` emits `symbols` (plural). Now falls back to the array's first entry.
