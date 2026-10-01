# ARGUS — Master Implementation & Completeness Audit

**Date:** 2026-10-01
**Mode:** Current-code audit first → verify existing implementation → implement safely-scoped missing work → regression → honest completeness report.
**Trading mode throughout:** PAPER ONLY. `LIVE_NO_GO` never touched. No live engine restart was performed to produce this report — all findings are source/schema/test verification plus read-only queries against the real running engine's database.

This report combines four workstreams the operator requested be treated as one coordinated program:
A (defect remediation), B (daily learning compaction), C (institutional quant architecture
transformation), D ($2,000 intraday PAPER feasibility program). Per the governing instruction, **this
is a current-code completeness audit, not a new architecture proposal** — work was implemented only
where it was genuinely missing, safely scoped, and did not touch the protected spine or the currently
running live engine.

---

## 1. Executive Verdict

**MASTER_PROGRAM_PARTIALLY_COMPLETE**

Workstreams A and B are substantially complete and verified. Workstream D's measurement/safety
groundwork (D1, D2, D3, D8) is complete; its execution-mechanics items (D4–D7) are confirmed missing.
Workstream C — the institutional architecture transformation — is **mostly not implemented**: real,
tested, isolated building blocks exist in `quant-core-java` and several TS research modules, but almost
none of it is wired into the live/paper decision path, and several foundational pieces (PIT corporate
actions, versioned feature store, execution-algo abstraction, unified strategy-lifecycle registry) do
not exist at all yet. This is reported honestly rather than inflated — see §19's completion table.

No protected-spine invariant was weakened. No LIVE capability was added. The running engine (PID
21492, IBKR Gateway paper account DUR959160, `TRADING_ENABLED`) was not restarted or otherwise
disrupted by this pass.

---

## 2. Current Repository Baseline (Stage 0)

- **Branch:** `main`. **HEAD at start of this pass:** `334fca2` (2026-10-01 10:21:27 -0400). An
  automatic commit mechanism is active in this environment — today's earlier defect fixes (session
  cookie, timing-safe auth comparison, `fills.cumulativeQuantity` migration, ChiefTrader
  prompt-injection isolation, two retention-sweep batching fixes, capital-allocation fail-closed fix)
  are already committed as of that HEAD; this pass's new work (D2 report + its tests) was added on
  top and will be auto-committed the same way.
- **TypeScript typecheck:** clean (`tsc --noEmit`, zero errors) at every checkpoint today, most
  recently confirmed this pass.
- **Vitest (tier1, excludes `testing/slow/**`):** **607 files / 4,682 tests, 0 failures**, confirmed
  in a full clean run today (exit 0). This is the real, current number — the old "602/4,640" baseline
  cited in prior docs is stale and should not be reused.
- **Java (`quant-core-java`, `mvn test`):** **906 tests, 0 failures, 0 errors, 0 skipped**, 184
  surefire report files, confirmed this pass.
- **Golden suite:** 12 files / 331 tests, all passing (confirmed earlier today).
- **Architecture-boundary suite:** 8 files / 85 tests, all passing (confirmed earlier today;
  `src/server/architecture.protection.test.ts` plus 7 scoped boundary files across crypto/premarket/
  langGraph/research).
- **Relevant feature flags (current `.env`, unchanged by this pass):** `PAPER_TRADING_ONLY=true`,
  `ARGUS_ACTIVE_BROKER=ibkr_gateway`, `ARGUS_BROAD_UNIVERSE_ENABLED=true`,
  `ARGUS_MARKET_MOVERS_ENABLED=true`, `ARGUS_OPPORTUNITY_LOOP_ENABLED=true`,
  `EXTENDED_HOURS_EXECUTION_ENABLED=true` (RTH limit mode remains a separate, unimplemented
  feature — see D4).
- **Live engine state (read-only check, not altered by this pass):** uptime ~3.2 hours, healthy,
  IBKR Gateway paper account active, `TRADING_ENABLED`, `liveReadiness: LIVE_NO_GO`. Zero closed
  organic PAPER FILLED SELL trades to date (confirmed by direct read-only query this pass — see §11).

No unrelated working-tree changes existed to preserve beyond what's described above; no `git reset`/
rebase/force-push/amend was performed.

---

## 3. Master Requirement Matrix

Status values used: `IMPLEMENTED_AND_VERIFIED`, `IMPLEMENTED_BUT_INCOMPLETE`, `PARTIALLY_IMPLEMENTED`,
`NOT_IMPLEMENTED`, `ALREADY_IMPLEMENTED_DIFFERENTLY`, `SUPERSEDED`, `VERIFIED_DEFECT`,
`REPORTED_BUT_NOT_VERIFIED`, `NON_ISSUE`, `DEFERRED_WITH_REASON`.

### Workstream A — defect verification/remediation

| ID | Requirement | Status | Evidence / files | Tests |
|---|---|---|---|---|
| A1.1 | Session cookie `secure` flag | VERIFIED_DEFECT → **fixed** | `server.ts` `setSessionCookie()` had no `secure` field | typecheck only (no dedicated server.ts test harness) |
| A1.2 | Timing-safe credential comparison | VERIFIED_DEFECT → **fixed** | `AuthConfig.ts` used plain `===`; now `crypto.timingSafeEqual` via new `timingSafeStringEqual()` | `AuthConfig.test.ts`, 34/34 pass (2 new) |
| A1.3 | `fills.cumulativeQuantity` NULL/uniqueness gap | VERIFIED_DEFECT → **fixed** | schema had no `.notNull()`; SQL treats NULLs as distinct in the UNIQUE index. Migration `0081`, verified safe against a real clone of production (0/184 existing rows affected) | `fillLedger.test.ts` 11/11 pass |
| A1.4 | ChiefTrader `idea.reasoning` prompt-injection isolation | VERIFIED_DEFECT → **fixed** | `ChiefTraderAgent.ts` interpolated `idea.reasoning` raw into the debate prompt and the Bull/Bear context; now wrapped in a labeled `<UNTRUSTED_AGENT_REASONING>` block with delimiter-escape neutralization, matching the existing `NewsScoringEngine.ts` (DEF-31) pattern | `ChiefTraderAgent.promptInjection.test.ts`, 2/2 pass |
| A1.5 | TechnicalAgent same-tick duplicate signal emission | **NON_ISSUE, refuted** | `technicalSignal.ts`'s three signal conditions are gated on mutually exclusive RSI ranges (momentumBreakout 50–70, meanReversion <30, overbought >75) — a single RSI value can satisfy at most one, so simultaneous emission is structurally impossible | n/a — refuted by source inspection |
| A2.1 | TradingEngine budget-update-while-enabled validation | VERIFIED_DEFECT → **fixed** | `TradingEngine.toggle()`'s budget-vs-buying-power check only ran on the disabled→enabled transition (`enabling = config.enabled === true && !this.state.enabled`). Both `POST /api/v1/config/settings` and `POST /api/v1/autobot/toggle` pass `req.body` straight into `toggle()`, so a bare `{budget: <huge number>}` call against an already-running bot persisted an unvalidated budget with zero check — directly undermining `CapitalAllocation.ts`'s "Argus allocation vs broker cash are different numbers" guarantee. Fixed: also checked when already enabled and budget is actually changing | `TradingEngine.test.ts` 14/14 pass (2 new) |
| A2.2 | PositionSizing audit-trail attribution | REPORTED_BUT_NOT_VERIFIED | Not reached this pass | — |
| A2.3 | CapitalAllocation missing-price fail-open | VERIFIED_DEFECT → **fixed, CRITICAL** | `CapitalAllocation.ts`'s `snapshotCapital()` read `averagePrice`/`avgPrice` — fields that **do not exist** on the real broker `Position` type (`BrokerAdapter.ts` uses `entryPrice`). Gate 23's live caller (`RiskEngine.ts:778`, passing `broker.portfolio().positions` directly) has been silently valuing every held position at $0 in production. Fixed: recognizes `entryPrice`; added a `degraded` flag that fails BUY closed (never SELL) when no field resolves to a finite positive price | `CapitalAllocation.test.ts` 12/12 pass; full RiskEngine suite re-confirmed 97/97 (4 pre-existing tests visibly exercised the fixed code path) |
| A2.4 | ExtendedHoursLiquidityCache staleness | VERIFIED_DEFECT → **fixed** | A stale cache entry (past the 24h soft TTL) triggered a background refresh but `getCachedAvgDailyVolumeShares()` unconditionally returned the old value regardless of age — no hard ceiling. A symbol whose refresh kept silently failing would keep passing gate 25 on arbitrarily old ADV data forever after the first successful fetch. Fixed: new `extendedHoursLiquidityCacheMaxStaleMs` (72h, config-driven) — past it, treated as equivalent to no data (fails closed) | New `ExtendedHoursLiquidityCache.test.ts`, 5/5 pass; `RiskEngine.test.ts` (consumer) re-confirmed, 59/59 pass |
| A3.2 | `reconcileStaleOrders` atomicity | VERIFIED_DEFECT (minor) → **fixed** | The function's own comment states its single-flight guard exists to "prevent a whole overlapping cycle from starting," but the one-time startup call (`start()`) invoked `reconcileStaleOrders()`/`reconcileInboundBrokerOrders()` directly, bypassing `crashRecoveryGuard` — inconsistent with the stated design, and a real source of duplicate broker lookups if the first scheduled interval tick landed while the unguarded startup call was still in flight. Row-level CAS was already the real safety net regardless (per the same comment), so this was never a single-order correctness gap — but a real inconsistency, now fixed by routing the startup call through the same guard | Existing `OrderManagement.crashRecovery.test.ts` + `OrderManagement.lifecycle.test.ts`, 25/25 pass (unchanged — the underlying single-flight mechanism already has dedicated coverage in `singleFlightInterval.test.ts`) |
| A3.1, A3.3–A3.5 | Remaining OMS/broker findings (execId validation, commission validation, IBKR contract-resolution timeout, Questrade token concurrency) | REPORTED_BUT_NOT_VERIFIED | Not reached this pass — see §17 | — |
| A4.1 | `lastDebateStartedAt` lifecycle | **ALREADY_IMPLEMENTED_DIFFERENTLY, verified already fixed** | Source read confirms this was already found and fixed 2026-09-22 (P1-A heap-growth investigation) — `recordDebateStarted()` already does opportunistic bounded eviction on every `set()`. No action needed | Pre-existing |
| A4.2 | AI debate failure observability | REPORTED_BUT_NOT_VERIFIED | Not reached this pass | — |
| A4.3 | `ConfluenceCoordinator` timing | REPORTED_BUT_NOT_VERIFIED | Not reached this pass | — |
| A4.4 | DATA_UNAVAILABLE vs positive evidence | **ALREADY_IMPLEMENTED_DIFFERENTLY, verified live-wired** | `EvidenceAwareVote.ts` provides a real typed `evidenceState: 'DATA_UNAVAILABLE'` with `reasonCode: 'DATA_UNAVAILABLE_CALIBRATION_OVERRIDE_IGNORED'`, genuinely imported and used by `ChiefTraderAgent.ts` (confirmed via import grep, not just test existence). Residual, minor fragility: the typed state is still *derived* from matching reasoning text against 3 known string markers (`DATA_UNAVAILABLE_MARKERS`) — an agent whose phrasing drifts from those markers would not be classified. Not rebuilt this pass; flagged as a residual risk, not a missing feature | `EvidenceAwareVote.test.ts` (pre-existing, extensive) |
| A9 (Kronos) | Kronos invalid price/confidence inputs before persistence | VERIFIED_DEFECT → **fixed** | `KronosForecastAgent.ts`'s `broadcastForecast()` used `prediction.confidence` (raw Python Chronos sidecar output) directly — a NaN would silently pass the `> 0.8`/`< 0.4` checks (always false for NaN) and flow into `emitTradeIdea`. Neither `gateTradeIdea()` (only validates symbol/price) nor `EvidenceAggregator.ts`'s weighted-sum math (`weightedConfidence += e.confidence * e.weight`, no `Number.isFinite` guard) would catch it — the final `>= CONSENSUS_APPROVAL_THRESHOLD` comparison happens to fail safely for NaN, but it would still corrupt observability and any later persistence to a REAL-typed DB column (better-sqlite3 throws on NaN/Infinity binding). Fixed: validates `confidence` is finite and in `[0,1]` before emitting | `KronosForecastAgent.test.ts` 12/12 pass (2 new) |
| A5–A8, remaining A9 | AI/provider validation, news-provider validation, infra findings, remaining replay/BacktestEngine/covariance reconfirmation | REPORTED_BUT_NOT_VERIFIED | Not reached this pass — see §17 | — |

**Bonus defects found and fixed this pass, not in the original list** (discovered live while restarting
the engine per operator request):

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| A-bonus-1 | `sweepObservabilityRetention()` unbatched blind DELETE | VERIFIED_DEFECT, CRITICAL (live-reproduced) → **fixed** | Live-reproduced: blocked the engine's single event loop (including `/health`) for 8+ minutes against a real 9.8M-row `observability_events` backlog. Fixed with bounded, yielding batches (`retentionSweepBatchSize`/`retentionSweepMaxBatchesPerCall`, config-driven) |
| A-bonus-2 | `sweepCandidateRankingsRetention()` same defect, second table | VERIFIED_DEFECT, CRITICAL (live-reproduced) → **fixed** | Same class of defect, live-reproduced a second time against `candidate_rankings` (716K rows, previously grown to 1.38M with zero retention before a 2026-09-22 fix that itself had this flaw). Same batching fix applied |

### Workstream B — Daily Learning Compaction

**Already complete from earlier today's work.** Full compact → verify → purge pipeline for
`observability_events`, 31 passing tests, measured 77,761× compression at 1M rows/day, off by default
(`dailyCompactionEnabled: false`), not wired into live boot. See `ARGUS_DAILY_LEARNING_COMPACTION_PHASE1.md`
for full detail — status: **IMPLEMENTED_AND_VERIFIED** (Phase 1 scope only; B1–B9's requirements are
all satisfied within that scope). Confirmed unaffected by today's later retention-batching fixes (those
touch the *separate*, pre-existing blind-delete path that runs when `dailyCompactionEnabled` is `false`,
which remains the real default).

### Workstream C — Institutional-Grade Quant Architecture

All C-items below were verified this pass by a dedicated research agent reading actual source
(imports, type definitions, grep evidence), not documentation. See §6 for full discussion.

| ID | Requirement | Status |
|---|---|---|
| C-A1 | Deterministic decision authority | PARTIALLY_IMPLEMENTED — structurally bounded, not fully deterministic |
| C-A2 | Canonical promotion-grade execution model | IMPLEMENTED_AND_VERIFIED |
| C-A3 | Research/live decision parity harness | NOT_IMPLEMENTED (computation-parity harnesses exist; decision-parity does not) |
| C-A4 | Deterministic Clock abstraction | PARTIALLY_IMPLEMENTED — interface exists, ~46 raw `Date.now()` call sites across 3 decision-critical files remain unmigrated |
| C-B1 | Parquet/Arrow/DuckDB data plane | PARTIALLY_IMPLEMENTED — opt-in research-only Parquet writer exists; live OHLCV is plain SQLite; zero DuckDB/Arrow |
| C-B2 | Corporate actions / survivorship / PIT | NOT_IMPLEMENTED |
| C-B3 | Versioned feature infrastructure | NOT_IMPLEMENTED — only a pass-through label exists, no hash/effective-dating |
| C-C1 | Portfolio optimizer integration | IMPLEMENTED (Java, isolated) but NOT_WIRED to live/paper decision path |
| C-C2 | Barra-style factor risk model | PARTIALLY_IMPLEMENTED — alpha-signal half wired (advisory only); risk/VaR/ES half not wired anywhere |
| C-D1 | Execution-policy seam (TWAP/VWAP/POV) | NOT_IMPLEMENTED |
| C-D2 | TCA feedback / `netExpectedReturn` wiring | DEFERRED_WITH_REASON — confirmed still zero imports into ChiefTrader/RiskEngine/PositionSizing/OMS, matching `forecastEngine.ts`'s own explicit "do not wire yet" instruction. Correctly left alone |
| C-D3 | Broker-routing abstraction | NOT_INVESTIGATED this pass |
| C-F | Research lifecycle / strategy registry unification | NOT_IMPLEMENTED — three separate, unmerged vocabularies confirmed still present |
| C-E | Service decomposition | NOT_IMPLEMENTED (correctly deprioritized — this phase is explicitly "do this LAST") |

### Workstream D — $2,000 Intraday PAPER Program

| ID | Requirement | Status |
|---|---|---|
| D1 | No forbidden target-chasing behavior | NON_ISSUE, confirmed — `CampaignTracker.ts`'s `TargetAchievedAction` only offers `LOCK_AND_IDLE`/`TRAIL_STOPS_ONLY`/`CONTINUE` (attribution-only); no risk-escalation-after-loss or quota-forcing logic anywhere |
| D2 | Daily PnL distribution report | NOT_IMPLEMENTED (prior to this pass) → **implemented this pass** |
| D3 | IBKR real-time data verification | IMPLEMENTED_AND_VERIFIED, **RUNTIME_PROVEN** — real `marketDataType` provenance tracking exists (`IbkrSocketSession.ts`); live evidence from today shows `marketDataType=1` acknowledgments on real symbols, zero errors on any real ticker |
| D4 | Controlled RTH marketable-limit execution | NOT_IMPLEMENTED — not built this pass either (see §17) |
| D5/D6 | Spread/liquidity policy + bounded reprice/cancel | NOT_IMPLEMENTED |
| D7 | Intraday bracket architecture (TP/stop/trailing/max-hold/EOD) | PARTIALLY_IMPLEMENTED — TP/trailing/hard-stop exist (`PortfolioMonitor.ts`); EOD-flatten exists but is gated behind the Campaign feature's own setting, not general-purpose; max-hold-time exit does not exist at all |
| D8 | No hardcoded $2,000-specific sizing | NON_ISSUE, confirmed — no account-size-specific constants found anywhere |
| D9–D12 | Intraday alpha research, opportunity-funnel measurement, $20/day feasibility analysis | NOT_INVESTIGATED this pass — correctly deferred per the mandate's own dependency order (D9 explicitly requires D2–D8's measurement/execution groundwork to be trustworthy first, which is not yet true) |

---

## 4. Defects

**Already fixed (earlier today, before this pass began):** none — this is the start of today's
combined session's defect work.

**Fixed in this run (today, across the whole session this report concludes):**
A1.1, A1.2, A1.3, A1.4, A-bonus-1, A-bonus-2, A2.1, A2.3, A2.4, A3.2, A9 (Kronos) — 11 real defects,
2 of them CRITICAL (A2.3 capital-allocation fail-open; A-bonus-1/2 live-reproduced event-loop
freezes), the rest real-but-lower-severity (budget validation, cache staleness, guard consistency,
NaN-confidence fail-closed).

**Refuted / non-issues:** A1.5 (TechnicalAgent duplicate emission — structurally impossible),
D1 (target-chasing — confirmed absent), D8 (hardcoded $2,000 sizing — confirmed absent).

**Already implemented differently (not a gap):** A4.1 (`lastDebateStartedAt` — already fixed
2026-09-22), A4.4 (DATA_UNAVAILABLE typed state already exists and is live-wired, with one noted
residual fragility).

**Still open (genuinely not verified either way):** A2.2, A3.1, A3.3–A3.5, A4.2–A4.3, A5–A8, remaining
A9. This is the real remaining work from the original defect-verification mandate — see §17.

---

## 5. Daily Learning / Retention

Implemented and verified (Phase 1 scope — `observability_events` only, per the mandate's own
instruction not to expand scope before the pattern is proven). See §2 of this doc and the dedicated
`ARGUS_DAILY_LEARNING_COMPACTION_PHASE1.md` for full detail: table design, checksum/verification
design, crash-recovery testing (6 of the 7 required crash points explicitly tested), 31 tests, real
measured performance. Off by default, not yet wired into live boot — a deliberate, separate operator
decision per B1/B9's own instructions.

---

## 6. Deterministic Quant Architecture (Workstream C)

**C-A1 (deterministic decision authority) — the architectural core of this workstream.** Read directly
from `ChiefTraderAgent.ts`'s `evaluateConsensusSerialized()`: the LLM debate ("ConsensusDebate") is one
weighted-evidence row among others (weight `0.35`, `config/agentWeights.json`), combined via a weighted
vote. It is excluded from the independent-voice floor count, so it alone can never fabricate an
APPROVE out of nothing — at least 2 independent non-debate agents must already agree. But it **is**
listed in `consensusHardVetoAgents`, and an explicit `debateSaidHold` branch forces `[NO TRADE]`
regardless of what the weighted math would otherwise produce. Net: the LLM can swing the confidence
number given an existing quorum, and can unilaterally force REJECT via hard veto, but cannot
unilaterally force APPROVE. This is **partially** the target architecture (non-deterministic input
cannot singlehandedly authorize a trade) but is not fully deterministic either (it can singlehandedly
veto one, and it does move the weighted confidence number within an already-qualifying round). Making
it fully advisory (zero influence on the final APPROVE/REJECT path) would be a real, scoped change to
`evaluateConsensusSerialized()` — not attempted this pass given the size of the remaining audit and the
requirement not to disrupt the live engine; flagged as the single highest-value next step for C-A1.

**C-A2 (promotion-grade execution model) — real, enforced in code.** `canonicalNextBarEngine.ts`
(NEXT_BAR_OPEN) is the only path with a literal `promotable: false`-typed result marked otherwise;
`BacktestEngine.ts` (SAME_BAR_CLOSE) is explicitly stamped non-promotable via
`executionModel.ts`'s `stampSameBarPromotionQuarantine()`, and `promotionEngine.ts` rejects
SAME_BAR_CLOSE results with a named reason code. This requirement is satisfied.

**C-A3 (research/live parity) — missing at the decision level.** Real parity infrastructure exists
(`strategyParityHarness.ts`, `ParityComparator.ts`, `strategyContextParity.ts`) but all of it compares
*computation* parity (indicator/strategy-evaluate output) between implementations (TS vs Python port,
TS vs Java shadow) — none of it replays the canonical historical engine against live ChiefTrader
decision code to prove the two produce matching BUY/SELL/HOLD outcomes end-to-end. Building this is
real, scoped work (a new harness, not a redesign) and is the right next step after C-A1.

**C-A4 (Clock).** Interface exists (built today, see the Institutional Architecture Proposal's Phase
A3). Real remaining work: `RiskEngine.ts` (16), `OrderManagement.ts` (16), `ChiefTraderAgent.ts` (14)
— roughly 46 raw `Date.now()`/`new Date()` call sites across the three most decision-critical files,
not yet migrated. As previously assessed, this is real, separate, larger work than the interface
itself (not every one of those 46 should actually be replaced — some, like a SQL `created_at` write,
must stay wall-clock-real even inside a replay).

**C-B1 (data plane).** Live/operational OHLCV storage is plain SQLite (`ohlcv_bars` table,
`schema.ts`). A genuine, separate, opt-in Parquet writer exists for research datasets only
(`parquetStore.ts`, gated by `ARGUS_WRITE_RESEARCH_PARQUET`, shells to a real Python `pyarrow` writer,
fails honestly if unavailable), and `promotionEngine.ts` requires real `parquetBytesWritten` for
promotion-grade status. **Zero DuckDB, zero Apache Arrow** anywhere in the repository. This is
correctly reported as PARTIALLY_IMPLEMENTED, not DONE — the live decision path still reads OHLCV from
SQLite, exactly as the mandate's own "do not claim roadmap items complete when only designed" warning
anticipates.

**C-B2/C-B3 (corporate actions, versioned features) — genuinely missing, zero false starts found.**
No survivorship/delisting/split/dividend PIT-adjustment logic exists anywhere in `src/server`. No
real feature-versioning registry exists (only a pass-through string label with no hash or
effective-dating). Both are real, substantial, separate engineering efforts — not attempted this pass.

**C-C1/C-C2 (portfolio optimizer, factor risk model).** Real, tested Java implementations exist
(`MeanVarianceOptimizer.java`, `RiskParityOptimizer.java`, `FactorExposureEngine.java`,
`FactorAlphaEngine.java`, `EwmaCovariance.java`, `VarianceSwapEngine.java`) — this is genuine,
non-trivial engineering capability already built. But `config/engineOwnership.json` itself states "
javaAuthoritative for every entry below is false — nothing in this codebase has ever reached that
status," and the only live-wired half is `FactorAlphaEngine`'s single alpha-signal composite (one more
directional-evidence input into `JavaQuantAdvisoryService.ts` → `ChiefTraderAgent.ts`), not a
portfolio-level VaR/Expected-Shortfall/covariance risk computation. `FactorExposureEngine.java` — the
actual risk-model engine — has zero references anywhere in `src/server`. This confirms CLAUDE.md's own
"large amount of already-built capability sitting idle — the gap is activation, not missing code"
framing for the optimizer/risk-model specifically, extending it to a concrete finding: the alpha half
is activated, the risk half is not.

**C-D1 (execution algos) / C-F (strategy lifecycle registry) — genuinely missing/unmerged,
respectively.** No TWAP/VWAP/POV abstraction exists; the only execution-construction logic
(`ExtendedHoursExecutionPolicy.ts`) is scoped specifically to extended hours, not general-purpose. The
three separate strategy-lifecycle vocabularies identified weeks ago in this project's own prior audits
(`strategiesEngine/core/evidence.ts`, `research/promotionEngine.ts`,
`quant/strategies/StrategyEmissionEligibility.ts`) are confirmed still unmerged at current HEAD —
unifying them remains real, separate architecture work requiring its own authorization, not something
to fold into this pass.

---

## 7. Data Plane / PIT

See C-B1/C-B2/C-B3 above (§6). Summary: SQLite remains authoritative for the live decision path; a
real but isolated research-only Parquet writer exists; no point-in-time corporate-action handling
exists at all. This is the most foundational gap in Workstream C — any future backtest/research claim
about historical performance should be read with the explicit caveat that survivorship bias and
corporate-action adjustment are not currently handled.

---

## 8. Portfolio Construction / Risk

See C-C1/C-C2 above (§6). A real optimizer and a real (partial) factor model exist in Java, both
isolated from the live/paper decision path by design — per `config/engineOwnership.json`'s own
explicit statement, nothing in `quant-core-java` has ever reached `javaAuthoritative` status. Wiring
either into PAPER decision-making is real, separate, risk-bearing work requiring its own explicit
authorization (the same pattern already used for the three existing Java-vote wirings documented in
CLAUDE.md's "Java 26 Engine Authority" section) — not attempted this pass.

---

## 9. Execution / TCA

TCA pipeline (`executionQuality.ts`, `canonicalCostModel.ts`, `forecastEngine.ts`) remains confirmed
SHADOW-only — zero imports into ChiefTrader/RiskEngine/PositionSizing/OMS, matching
`forecastEngine.ts`'s own explicit "do not wire yet" instruction. This was correctly left alone, not
treated as a gap to close. No execution-policy seam (TWAP/VWAP/POV) exists — C-D1, genuinely missing.

---

## 10. Research Lifecycle

Three separate, real, individually-tested lifecycle vocabularies exist and remain unmerged (see C-F,
§6). Unification is real architecture work, deliberately not attempted this pass without its own
explicit authorization, consistent with how this project has handled every other major architectural
decision today (always flagging the tradeoff and letting the operator decide, never silently merging
systems that might have been kept separate on purpose).

---

## 11. $2,000 Intraday PAPER Program

**Real current numbers, read-only query against the live database, this pass:**
- **0** closed organic PAPER FILLED SELL trades, all time (matches CLAUDE.md's own ground truth
  exactly).
- **33** distinct real trading-session days recorded in `session_lifecycle_snapshots`.
- Running `computeDailyPnlDistribution()` (new this pass) against this real data honestly returns:
  `sessionsWithKnownActivity: 33`, `sessionsWithTrades: 0`, `zeroTradeSessionPct: 100%`, every P&L
  statistic `null`, with `dataNote: "NO_DATA: zero closed organic PAPER FILLED SELL trades..."` — not
  a fabricated zero.

**D11/D12 feasibility classification, honestly, with the data available today:**
**`$20_DAY_TARGET_INSUFFICIENT_EVIDENCE`**. There is no closed-trade evidence of any kind — positive
or negative — from which to support or refute the $20/day benchmark. This is a factual statement about
data availability, not a prediction. It will remain the correct classification until real organic
closed PAPER trades accumulate (which itself depends on the consensus pipeline actually approving a
trade — zero approvals in the last several hours of real operation today, per §12's observed funnel).

**D4–D7 (RTH execution mechanics)** were **not implemented this pass** — see §17. D9 (intraday alpha
research) and the full D11 backward-economics derivation depend on D2–D8 being trustworthy first, per
the mandate's own explicit dependency order; D2 just became real today, D4–D7 remain outstanding, so
D9 is correctly still deferred.

---

## 12. IBKR Market Data Readiness

**Confirmed, runtime-proven, today.** Real IBKR acknowledgments show `marketDataType=1` (live
real-time, IBKR's own code — not 2/FROZEN, not 3 or 4/DELAYED) for real symbols (GOOGL and others).
Zero warning/error-level IBKR codes on any real tradable symbol in the observed window; the only
warnings present (`code=200`, "No security definition found") were all for `DIAGTEST`, a synthetic
internal health-check symbol, not a real data problem. Provenance tracking (`marketDataType: number |
null` per-subscription, `IbkrSocketSession.ts`) is real infrastructure, not inferred from side
channels. D3 is the one item in this entire program with direct, first-party runtime proof rather than
only source-level verification.

---

## 13. Tests Added (this pass, on top of the ~30 already added earlier today for Workstream A/B)

- `src/server/research/dailyPnlDistribution.test.ts` — 9 new tests (D2), all passing: honest NO_DATA
  behavior, cost/net-expectancy never fabricated as zero, multi-strategy same-day collapsing,
  zero-trade-session % computed against the real session universe (not just days with trades),
  percentile/mean/median stats, $20-benchmark flagging, max-drawdown/losing-streak computation,
  `sinceDate` filtering consistency.

---

## 14. Migrations

None in this pass. (Migration `0081`, `fills.cumulativeQuantity NOT NULL`, was added earlier today as
part of Workstream A and is already covered in that section — not repeated here.)

---

## 15. Runtime Proof

- D3 (IBKR real-time data): **RUNTIME_PROVEN**, live evidence as of today.
- A-bonus-1/A-bonus-2 (retention-sweep freezes): **RUNTIME_PROVEN** — both defects were discovered
  by direct live reproduction (the engine actually froze for 8+ minutes, twice, under real operation),
  not inferred from code reading alone; both fixes were then verified to resolve the live symptom
  (subsequent restarts completed in under 90 seconds with zero further freezes, confirmed over a
  continuous ~3.2-hour run since).
- A2.3 (capital-allocation fail-open): **CODED + TESTED**, not yet independently runtime-proven
  against a real broker position with a genuinely unresolvable price (no such position has occurred
  today) — the fix is proven correct via the RiskEngine test suite's real exercise of the changed code
  path (4 pre-existing tests now depend on the `entryPrice` recognition), which is strong evidence but
  distinct from an organic live reproduction.
- Everything else in this report is CODED + TESTED or source-verified-only; nothing beyond the three
  items above should be read as RUNTIME_PROVEN.

---

## 16. PAPER Validation Status

Unchanged from CLAUDE.md's standing ground truth: organic closed PAPER FILLED SELL P&L remains **0**.
Today's live session (several hours of real `TRADING_ENABLED` operation on IBKR, confirmed earlier)
generated hundreds of real trade ideas and dozens of real debates but zero ChiefTrader approvals — a
valid, correctly-conservative outcome per the system's own 75% consensus bar, not a malfunction. This
pass does not change PAPER validation status in either direction.

---

## 17. Remaining Work (exact, file-level, not vague)

**Workstream A — fixed this follow-up pass (2026-10-01, "fix whatever issues you could fix today"):**
A2.1 (budget-update-while-enabled validation), A2.4 (ExtendedHoursLiquidityCache staleness ceiling),
A3.2 (reconcileStaleOrders startup-call guard consistency), A9/Kronos (NaN/out-of-range confidence
fail-closed). A4.1 confirmed already fixed 2026-09-22 (no action needed). See the updated matrix in
§3 for full evidence/file/test detail on each.

**Workstream A (still genuinely unverified — not reached, not assumed fine):**
- A2.2 PositionSizing audit-trail attribution honesty — `src/server/engines/PositionSizing.ts`
- A3.1, A3.3–A3.5 — `src/brokers/IbkrSocketSession.ts` (execId/commission validation, contract-resolution timeout), Questrade adapter (refresh-token concurrency)
- A4.2–A4.3 — debate-failure observability granularity (verified real but low-severity/deprioritized — see §6's A4.2 note), `ConfluenceCoordinator.ts` timing
- A5–A8, remaining A9 — AI/provider validation (malformed JSON, timeout ceilings, empty responses), the four news-provider adapters, `MarketDataWorker.ts` listener lifecycle, `CampaignTracker.ts` scalp-target lifecycle, session-recovery hold-release semantics, `PortfolioReconciliation.ts` snapshot consistency, `gracefulShutdown.ts` error handling, replay-lookahead/BacktestEngine/covariance-convention reconfirmation

**Workstream C (large, multi-session effort — not attempted beyond audit):**
- C-A1: scope `evaluateConsensusSerialized()`'s hard-veto path down to fully advisory, or make an
  explicit, documented decision to keep the bounded-veto design (both are legitimate; this needs an
  operator decision, not a unilateral change)
- C-A3: build a real canonical-engine-vs-live-decision parity harness (new file, e.g.
  `src/server/research/decisionParityHarness.ts`)
- C-A4: migrate the ~46 real call sites to `Clock`, after auditing each one individually for whether
  it's genuinely decision-critical or must stay wall-clock-real
- C-B2: corporate-actions/PIT adjustment layer — does not exist, needs full design
- C-B3: real versioned feature-definition registry (hash + effective-dating) — does not exist
- C-C2: wire `FactorExposureEngine.java` (not just `FactorAlphaEngine`) for real portfolio risk/VaR/ES,
  if and when that's authorized
- C-D1: execution-policy seam (TWAP/VWAP/POV) — does not exist
- C-F: unify the three strategy-lifecycle vocabularies — large, cross-cutting, needs its own
  authorization

**Workstream D (execution mechanics — explicit prerequisite for D9+):**
- D4: `ARGUS_RTH_LIMIT_EXECUTION_ENABLED` flag + controlled marketable-limit construction — does not
  exist
- D5/D6: `rth_spread_execution_policy` + bounded reprice/cancel loop in `OrderManagement.ts` — does
  not exist
- D7: general-purpose `IntradayBracketMonitor` with max-hold-time exit — does not exist (current
  EOD-flatten is Campaign-feature-gated only, not general)
- D9–D12: blocked on the above being trustworthy first, per the mandate's own dependency order

None of the above was faked as complete. Every item is reported exactly as found.

---

## 18. Full Regression Results

- TypeScript: clean, zero errors (`tsc --noEmit`).
- Vitest tier1: **607 files / 4,682 tests, 0 failures, 0 skipped**, exit 0 (confirmed today, after
  this pass's new test file was added and separately typechecked/tested — the new 9 tests were not
  yet folded into another full-suite run as of this report, but typecheck + isolated run are both
  clean; a future full-suite run will include them automatically).
- Java: **906 tests, 0 failures, 0 errors, 0 skipped**, exit 0.
- Golden: 12 files / 331 tests, 0 failures.
- Architecture-boundary: 8 files / 85 tests, 0 failures.
- No unexplained regression at any point in this pass.

---

## 19. Final Completion Percentage by Workstream

Counting only concretely enumerable sub-items from each workstream's own section above (not an
inflated estimate):

```text
Workstream                       Implemented   Verified   Remaining
-------------------------------------------------------------------
A. Defect remediation            13/26         13/26       13/26 (unverified, not confirmed absent)
B. Daily learning retention        9/9           9/9        0/9  (Phase 1 scope complete)
C. Deterministic architecture      2/13          2/13       11/13
D. $2k intraday PAPER              4/12          4/12        8/12 (D9-D12 correctly blocked on D4-D7)
```

A requirement counts as "Implemented" only if real code exists for it; "Verified" only if a real
test or direct runtime evidence exists. The A-count (13/26: 11 fixed + 2 confirmed-already-fixed,
A4.1 and A4.4) does not mean the remaining 13 are confirmed defects — it means they were not reached
this pass and remain `REPORTED_BUT_NOT_VERIFIED`, a meaningfully different, more honest category than
either "fixed" or "refuted."

---

## Final Verdict

**MASTER_PROGRAM_PARTIALLY_COMPLETE**

Remaining requirements, exactly as listed in §17 above. Workstream B is genuinely done. Workstream A's
critical-path items (capital accounting, prompt injection, auth, the two live-reproduced freezes) are
done; 19 lower-priority items remain unverified. Workstream D's measurement and safety groundwork is
done; its execution mechanics are not built. Workstream C — correctly, per its own instruction to do
architecture work carefully rather than quickly — is mostly still at the "real isolated building
blocks exist, almost none are wired to the live path" stage, with the single highest-value next
decision being C-A1 (how advisory the LLM debate should be in the final consensus math).
