# ARGUS Pre-Market TradePlan Lifecycle — Design

**Date:** 2026-10-06 (local-only; PAPER / RESEARCH ONLY; LIVE_NO_GO)
**Status:** Implemented, test-verified. Live PAPER-session validation pending.
**Goal:** `argus-stock-discovery-enhancement`

## 1. Problem (operator-verified)

On 2026-10-06 ~08:29 ET the operator inspected the live deployment: the engine had
started ~08:23 ET during PREMARKET, the session was correctly recognized
(`PREMARKET_SESSION_STARTED` fired), and `TradePlanBuilder` ran **once at startup**,
producing 5 real plans (PRIMARY: TSM BUY, OKTA BUY, DELL SELL; BACKUP: MRVL SELL,
HPE SELL) — each with substantive thesis and score decomposition. No newer plans
appeared afterward, while general discovery (quant assessments, candidate
admission/filtering, subscriptions) stayed active.

The defect was therefore **not** "premarket analysis is not running." It was:
**TradePlan intelligence is a one-time startup snapshot rather than a premarket
lifecycle incorporating later morning evidence.** A plan built at 08:23 stayed
authoritative at 09:29 merely because it existed, missing 08:30 economic releases,
mid-morning catalysts, pre-market movers, and gap evolution.

A second live observation the same morning: plan output rendered
"Relative volume 0.00x (score N/A)". There is no premarket time-of-day RVOL in
Argus (see §8); rendering `0.00x` is misleading. It must read
`PREMARKET_RVOL_UNAVAILABLE`.

## 2. Lifecycle

Four scheduled lifecycle points plus event-driven material refreshes. No timers
inside `TradePlanBuilder` — all scheduling rides the existing tick abstractions
(`SessionLifecycleManager` tick, `SnapshotScanner` tick, ET wall-clock checks via
`minutesInTimezone`).

| # | Point | Window (ET) | Purpose |
|---|---|---|---|
| 1 | Initial build | on `PREMARKET_SESSION_STARTED` | Build immediately from evidence-as-of startup. A late start (e.g. 08:23) builds immediately and records `sessionPhase` + `evidenceAsof` — it never pretends to be a 04:00 plan. |
| 2 | Mid-morning refresh | after 08:30 | Incorporate 08:30 economic releases and mid-morning catalysts. |
| 3 | Late refresh | ~09:00–09:15 | Re-rank on the full morning's evidence; rebuild plans, tiers, levels. |
| 4 | Pre-open validation | ~09:20–09:28 | Fresh quote, spread, catalyst freshness, levels, gap, strategy applicability, data readiness. Downgrade/expire on invalidation. |

**Event-driven material refreshes** (debounced, cooldown-guarded, material-change
threshold — no per-tick churn): high-impact `NEWS_CATALYST`, `MARKET_DATA_GAP_DETECTED`
(data-quality recovery → re-validate readiness), `MACRO_ANALYSIS_COMPLETED`.
Deliberately not subscribed: new-market-mover / price-acceleration / sector-RS
events do not exist on the bus; they flow through ranking inputs every scanner tick
and are covered by the scheduled refreshes' re-ranking.

**Open handoff:** when the session leaves PREMARKET, the lifecycle emits
`PREMARKET_PLAN_HANDED_TO_RTH` and releases/expires all data reservations
(market-open handover). Intraday Fast Lane/discovery are untouched and stay free.

## 3. Versioning — never overwrite invisibly

`trade_plans` gained (migrations 0089, 0092):
- `refresh_version` (1 = initial build), `refreshed_at`, `reason_for_refresh`
  (`INITIAL_BUILD | MID_MORNING_REFRESH | LATE_REFRESH | PREOPEN_VALIDATION |
  EVENT_DRIVEN_MATERIAL`, plus `PROMOTED`/`DOWNGRADED` markers)
- `original_created_at` (preserved across refreshes), `evidence_asof` (newest
  evidence timestamp incorporated), `session_phase` (e.g. `PRE_MARKET`)
- `score_decomposition_json` (decomposed pre-market score, §6)

Every refresh that changes a plan first writes the **prior version** to
`trade_plan_revisions` with a delta summary (tier, direction, score, catalyst,
gap, data-readiness changes). Reuses the existing `status` values
(`DRAFT/READY/REVALIDATING/VALID/INVALIDATED/EXPIRED`); no parallel state machine.

**No-churn:** recomputation is hashed (canonical sha256 snapshot). Byte-identical
plans produce `TRADE_PLAN_UNCHANGED` — no DB writes, no event noise.

## 4. Tiers

`PRIMARY / BACKUP / WATCH`, plus `DOWNGRADED / EXPIRED` terminal markers and a
`REJECTED` bucket in the focus report. **PRIMARY means "highest-priority to
monitor/evaluate" — never "trade this."** Selection does not imply actionable;
the lifecycle never emits trade ideas (the pre-existing
`ARGUS_TRADE_PLAN_IDEAS_ENABLED`-gated path is untouched and defaults OFF).

## 5. Bounded pre-open data reservations

`premarket_data_reservations`: a PRIMARY-tier plan may hold a **bounded, expiring**
reservation for subscription capacity so it has fresh data at the open.

- Pool: `premarketReservedSlots: 4` of `maxActiveSubscriptions: 12`
  (`config/continuousIntelligence.json`; cross-validated `< maxActiveSubscriptions`).
- TTL: `premarketReservationTtlMinutes: 25`; hard expiry at the
  `premarketReservationHandoverEt: "09:25"` market-open handover — every
  reservation dies before the 09:25–09:35 momentum-rotation window, so
  09:20–09:30 emerging movers can never be starved.
- Priority: `ACTIVE_POSITION(50) > PENDING_ORDER(40) > PRIMARY_PLAN(30) >
  FAST_ACTIONABLE(20) > NORMAL_DISCOVERY(10)` (confirmed against
  `MarketDataWorker`'s classes; PRIMARY_PLAN rides the existing `EXPLORATION`
  rescue class — no second market-data path).
- Release: plan expiry, tier drop, stale evidence, invalidation, or open handoff.
  Pool exhaustion returns explicit persisted `POOL_EXHAUSTED` denials. No zombies.

## 6. Decomposed pre-market opportunity score

`src/server/premarket/PremarketOpportunityScore.ts` — 10 separately observable
components, no opaque blended number. Weights live in
`config/premarketFocus.json` (validated: sum to 1, ordered tier cutoffs):

| Component | Weight | Notes |
|---|---|---|
| overnightGap | 0.15 | direction-blind magnitude |
| preMarketPctChange | 0.15 | direction-blind magnitude |
| catalystPresence | 0.15 | strongest single review reason |
| catalystRecency | 0.10 | linear decay to 0 at 12h |
| signedSentiment | 0.10 | **contextual only**; max |contribution| = weight; never a trigger |
| liquidity | 0.10 | illiquid = not worth attention |
| spreadQuality | 0.05 | unknown spread = fail-open neutral |
| sectorRelativeStrength | 0.05 | context; often honestly unavailable |
| marketRelativeStrength | 0.05 | context; often honestly unavailable |
| strategyApplicability | 0.10 | valid pre-market setups deserve attention |

Tier cutoffs: PRIMARY 0.70 / SECONDARY 0.50 / WATCH 0.30. Missing inputs score 0
and are listed in `inputsMissing` — never fabricated. The breakdown carries no
direction/side field by design.

Placement note (repo AGENTS.md — Java Engine Authority): this is
orchestration-layer candidate ranking, the same layer as the existing
`ComposableRanking.ts` — not a new indicator/strategy calculation — so
TypeScript is the correct home. A true PM_RVOL computation, when unblocked,
belongs in `quant-core-java/`.

## 7. News: sentiment + extraction

- **Sentiment flow** (verified): `LocalSentiment` (FinBERT
  `signedScore −1..+1`) → `NewsImpactEngine.assess()` → `NEWS_SENTIMENT_SCORED`
  → `news_clusters.sentiment_score` → `NewsCatalystStore` → ranking.
  Keyword-heuristic fallbacks are coerced to null (FinBERT-only by design).
- `ComposableRanking`'s news component now adds a symmetric `|sentiment|` term
  (`sentimentSalienceWeight: 0.25`, config): sign can never become BUY/SELL.
- **Extraction** (`NewsSymbolExtractor.ts`, 4 stages): provider symbols →
  explicit `$TICKER` (shape-validated) → company-name → ticker (127-ticker
  `tickerLexicon.ts`, capitalization rule for common-word aliases) → bare
  uppercase tokens vs lexicon, with a 20-entry stoplist (CAT, AI, C, ON, IT…)
  requiring nearby company-name evidence. Coverage limits are documented in the
  lexicon header: mid/small caps resolve via `$TICKER`/provider only, never
  guessed from prose.

## 8. Pre-market RVOL: BLOCKED_BY_DATA

Verdict: **`PREMARKET_RVOL=BLOCKED_BY_DATA`**. Evidence: `ohlcv_bars` (the only
historical bar table) holds 0 rows; per-symbol historical depth is 0 sessions
(a median baseline needs ~20+). The provider *can* supply pre-market bars
(Alpaca 1Min includes them; `supportResistance.premarketHighLow()` expects
them) — the blocker is missing stored data, not provider capability. The exact
missing piece is an authorized ~20-session pre-market 1Min backfill per symbol.

Until then: any null/zero/non-positive RVOL in a premarket context renders as
**`PREMARKET_RVOL_UNAVAILABLE`** — never `0.00x`. (`formatPremarketRvol()` in
the focus-report display layer; tested.)

## 9. Observability events

`PREMARKET_PLAN_BUILD_STARTED/COMPLETED`, `TRADE_PLAN_VERSION_CREATED`,
`TRADE_PLAN_UNCHANGED`, `TRADE_PLAN_PROMOTED/DOWNGRADED/EXPIRED`,
`PRIMARY_DATA_RESERVATION_REQUESTED/GRANTED/DENIED/RELEASED`,
`PREOPEN_REVALIDATION_STARTED/COMPLETED`, `PREMARKET_PLAN_HANDED_TO_RTH`,
`PREMARKET_CANDIDATE_SCORED` (bounded decomposition payload; bus emit plus a
direct structured log mirroring the proven `DISCOVERY_CANDIDATE_ADMITTED`
pattern). Subscribers are defensive and never throw into the bus.

## 10. Operator surface

- **CLI:** `argus premarket-focus [--date=YYYY-MM-DD]` — session phase, last
  build (time + version + evidenceAsof), next refresh (kind + time), plan
  counts, oldest plan age with **REFRESH_DUE** warnings, tiers with
  score/direction/catalyst/data-readiness/plan-age/version/refresh-reason, and
  promotions/downgrades/expiries since the previous build. Heavy logic lives in
  `getPremarketFocusCliView()`; the CLI only formats.
- **Focus report persistence:** `premarket_focus_reports` (one row per
  date×refresh-version), built by `PremarketFocusReport.ts`.
- **Boot:** `[PremarketDiscovery] PREMARKET_BROAD_UNIVERSE/MOVERS/NEWS/REFRESH=ON/OFF`
  line in `ArgusCoreBoot.ts` from the production flag readers; lifecycle and
  focus-report subscribers installed at boot in matching try/catch blocks.
- **Config hygiene:** every discovery flag documented in `.env.example`
  (including the previously missing `ARGUS_MARKET_MOVERS_ENABLED` and
  `ARGUS_NEWS_CATALYST_DISCOVERY_ENABLED`). All funnels stay OFF by default;
  the lifecycle consumes whichever sources are enabled and records them in
  each report's `sources_json`. PAPER-scoped enablement only.

## 11. Invariants (architecture tests enforce)

- The lifecycle never places orders, never approves trades, never bypasses
  consensus (0.75), RiskEngine (25 gates), OMS, or BrokerManager.
  (`tradePlanLifecycleBoundary.test.ts`, `premarketArchitectureBoundary.test.ts`.)
- Reflection/diagnostics never auto-tune thresholds, weights, or gates.
- No second execution path: reservations ride `MarketDataWorker`'s existing
  rescue/subscription infrastructure.
- Consensus threshold 0.75, independence requirements, freshness, and capital
  limits are untouched.

## 12. Performance (measured, fixture DB)

- INITIAL_BUILD (3 plans): 21.2 ms, 15 DB queries, event-loop lag 0.12→0.22 ms
- MID_MORNING_REFRESH (3 plans): 13.5 ms, 6 DB queries, lag 0.23→0.06 ms
- Asserted bound: DB queries ≤ 6 + 4×plansProcessed. No unbounded sync scans.
  (Production numbers will differ; the measurement + bound are in place.)

## 13. What is intentionally not here

- True PM_RVOL (blocked on data — §8).
- Post-market mover-vs-coverage reflection (Part B).
- TUI Daily Reflection page (Part B).
- Auto-tuning of any threshold from lifecycle output (never).
- NYSE holiday/early-close awareness (pre-existing gap, unchanged).
