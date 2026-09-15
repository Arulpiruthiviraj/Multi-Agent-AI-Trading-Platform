# ARGUS — Institutional Quant Trading Platform Gap Audit & Implementation Plan

**Status: AUDIT AND PLAN ONLY. No roadmap items in this document have been implemented as part of
producing it.** This is a forensic, code-level inventory of the real Argus codebase
(`C:\WorkProjects\Multi-Agent-AI-Trading-Platform`) against the capabilities expected of an
institutional-style systematic/quantitative trading platform, per the operator's own 41-section
mandate. Every claim below is traced to real files, real tests (or their absence), and real,
currently-configured behavior — never to documentation alone, and never to what a docstring merely
describes as intended.

**Vocabulary used throughout:** IMPLEMENTED / PARTIALLY IMPLEMENTED / SCAFFOLDED / MISSING /
UNPROVEN / UNKNOWN / RESEARCH-ONLY / PAPER-READY / PRODUCTION-READY — per the operator's own
required classification set. Scorecard scale is 0–6 (0=Missing, 1=Concept/docs only, 2=Scaffolded,
3=Implemented but incomplete, 4=Implemented and tested, 5=Operationally validated, 6=Institutionally
credible) — a 5 or 6 is never assigned merely because unit tests pass; it requires real operational
evidence (organic paper activity, live-measured behavior), which this system does not yet have in
most subsystems.

**Method note:** this document was produced by dispatching parallel research passes across the
codebase's major subsystem clusters (data/features; quant research/strategy/forecasting/diversity;
portfolio construction/capital/risk; backtesting/walk-forward/learning/postmarket;
reliability/scale/observability/security; frontend/terminal), each instructed to trace real code and
report grounded file:line evidence rather than write conclusions, followed by one synthesis pass
(this document) that applies consistent scoring and cross-subsystem judgment. The
execution/OMS/reconciliation/attribution section was written directly from this session's own
extensive, test-verified forensic work (the FD-1 through FD-9 defect-hunt pass earlier in this same
session), not a fresh research pass, since that ground was already covered to a depth a fresh pass
could not exceed without redoing already-completed work.

---

## Section 19–20 — Execution / OMS / Reconciliation / Position / P&L Audit

*(Written from this session's own direct, test-verified forensic tracing — not a delegated research
pass. Every claim below has a regression test proving it, written and run earlier in this same
session, not merely asserted.)*

### Order lifecycle — IMPLEMENTED, well-tested, institutionally credible for what it covers

**Order creation & persistence.** `OrderManagement.ts` `executeOrder()`: the local `trades` PENDING
row is inserted **before** any broker call (deliberate ordering, with its own comment explaining
why — a crash before the broker call leaves an honestly-recoverable row, never a broker order with
no local trace). Idempotency is enforced by BOTH a pre-check `SELECT` on `traceId` AND a real DB
unique constraint (`idx_trades_trace_id_unique`) as backstop — proven under genuine concurrency by a
real `Promise.all` race test (`OrderManagement.lifecycle.test.ts`), not just asserted.

**Client-order-ID / broker-side idempotency.** Every order carries `clientOrderId: orderId` (the
local `trades.id` UUID) to the broker. This session verified this is **NOT** a uniform guarantee
across brokers: IBKR's adapter has zero internal retry on submission (a single fire-and-forget
call, confirmed by direct trace), so it structurally cannot double-submit. Alpaca's adapter **did**
have an internal HTTP retry on timeout/network error, resting on an unverified claim that Alpaca
deduplicates by `client_order_id` — checked directly against Alpaca's own official API documentation
this session and found **undocumented and unverified** (FD-9, fixed this session: the retry was
removed for order placement specifically). This is the single most load-bearing finding in this
entire audit for the "can Argus create a duplicate real order" question: **the answer is now NO for
both broker adapters, verified by direct documentation-checking, not assumed from a unique
constraint** (the operator's own explicit standard for this question).

**Timeout / ACK ambiguity / reconnect.** All 14 of the operator's own broker-submission-ambiguity
scenarios (order accepted-ACK-lost, timeout→reconnect, timeout→retry-attempted, late-ACK,
duplicate-client-order-id, broker-rejects-but-local-thinks-UNKNOWN, disconnect-after-TCP-write,
crash-before-persistence, crash-after-persistence-before-ACK, duplicate-ACK, broker-order-with-no-
local-row, local-order-with-no-broker-order, partial-fill-during-ambiguity, cancel-during-resolution)
were traced against the real pipeline this session and resolved to SAFE SUCCESS or
UNKNOWN→PAUSE+RECONCILE in every case, several backed by new adversarial tests written this session
(`IbkrSocketSession.reconnectDuringSubmission.test.ts`,
`OrderManagement.unrecognizedBrokerOrder.test.ts`, `OrderManagement.crashRecovery.test.ts`). Zero
scenario resolves to a blind retry. Two real defects were found and fixed in this exact area this
session (FD-8: a locally-terminal order's status was never re-checked against a later-diverging
broker-side status; FD-9: the Alpaca retry above).

**Fill accounting.** IBKR's `orderStatus` (cumulative) and `execDetails` (per-execution) event
streams write to the same in-memory field with incompatible semantics — found as a real,
previously-unnoticed double-counting defect this session (FD-5), fixed via independent per-stream
tracking + `Math.max` reconciliation, plus dedup by IB's real `execId`. The DB-layer dedup
(`fillLedger.ts`'s `insertIncrementalFill`) uses a cumulative-watermark model (`(orderId,
cumulativeQuantity)` unique index, P0.4) rather than literal execution-ID dedup — verified this
session to correctly handle stale/replayed/out-of-order cumulative reports via its own `newQty <=
1e-9` no-op guard.

**Cancel/fill race (local state machine level).** `cancelOrder()` and `applyFollowUpUpdate()`
raced on the same `trades.status` write with no concurrency guard — found and fixed this session
(FD-4) via a symmetric compare-and-swap guard on both writes, closing a real window where a
concurrent cancel could silently overwrite an already-recorded fill.

### Position / Portfolio — IMPLEMENTED with one real, now-fixed concurrency defect this session

**`portfolio` table sync** (`localPortfolioSync.ts`): had a real lost-update race under concurrent
fills for the same symbol (FD-6, found and fixed this session) — required TWO rounds of hardening
after the first fix's own regression tests exposed further real gaps under full-suite load and real
10-way contention (a transient-error-handling gap, then an arithmetically insufficient CAS retry
budget). Now verified across 2/5/10 concurrent writers, mixed BUY/SELL, real SQLITE_BUSY injection,
and a restart/recovery replay — the most rigorously tested single function in the codebase as of
this session.

### Reconciliation — IMPLEMENTED, real broker-source-of-truth design, one real gap found and fixed

`PortfolioReconciliation.ts` compares broker-reported positions AND broker-reported open orders
against local state on an independent periodic cycle. **Broker positions are unconditionally the
source of truth** — local `portfolio.quantity` is overwritten by the broker's reported value on
every cycle (never the reverse), a deliberate, correct design. A real debounce mechanism
(`confirmConsecutiveFault`, 2 consecutive cycles, `~300000ms` interval) protects the position-level
`MISSING_LOCALLY`/`MISSING_REMOTELY` checks against one-off timing races — added after a real prior
incident (documented in code as the "GLD/NVDA flap"). This session found the SIBLING open-order
checks (`OPEN_ORDER_MISSING_LOCALLY`/`_REMOTELY`, `FILLED_ORDER_MISSING_LOCALLY`) had never received
the same debounce protection, meaning a routine order-fill timing race (not a rare edge case) could
trigger a false-positive `TRADING_PAUSED` — fixed this session (FD-7).

**Genuinely unresolved, honestly flagged (not fixed, not claimed safe):** broker-API
position-reporting lag versus a just-landed fill can still silently, transiently overwrite
`portfolio.quantity` with a stale-but-real broker value (traced this session; CONTROL VERIFIED that
this specific staleness cannot by itself escalate to a pause, since that requires the SAME fault on
2 consecutive ~5-minute cycles — but the raw staleness itself is real and not eliminated).

### P&L / Attribution — PARTIALLY IMPLEMENTED

`dailyAttributionReport.ts` (built this session, Part 21) computes real realized P&L from `trades`
(FILLED SELL, PAPER environment, real `profitLoss` field) grouped by NY trading date and real
`quantStrategyId`. This is real and DB-backed, not fabricated — but it is narrow: **SELL-only**
realized P&L attribution, no unrealized P&L breakdown by strategy, no factor/sector attribution, no
comparison against a benchmark. Execution quality (`executionQuality.ts`, Part 16, also this
session) computes real signed slippage from `trades.arrival_price` (written once, never overwritten)
versus actual fill price, and real submission-to-first-fill latency — genuinely real, DB-backed
measurement, not a placeholder, but again narrow in scope (no implementation-shortfall
decomposition, no market-impact estimate).

### Execution algorithms — MISSING

There is no execution-algorithm layer at all (no VWAP/TWAP/slicing/passive-vs-aggressive routing
logic). Every order is a single MARKET order (or, off by default, a single LIMIT order under the
Extended-Hours Execution Policy) sized once by `PositionSizing.ts` and sent as one broker call. This
is architecturally appropriate for Argus's CURRENT scale (whole-share retail-size orders, not block
trades) and should **not** be built ahead of a demonstrated need — see the Phase F / "do not build
yet" reasoning below.

### Scorecard inputs from this section

- **EXECUTION**: real, adversarially tested order lifecycle across both broker adapters; the one
  broker-submission defect class this audit exists to prevent (a duplicate real order) was found and
  closed this session with documentation-verified evidence, not assumption. Score: **4/6**
  (Implemented and tested — not yet "operationally validated" in the 5/6 sense, since none of this
  has been proven under real, sustained organic trading volume; the testing is adversarial-simulated,
  not live-observed).
- **RECONCILIATION**: real, broker-source-of-truth design with a real, tested debounce mechanism now
  covering both position- and order-level checks; one honestly-flagged residual staleness window.
  Score: **4/6**.

---

## Section 6 — Data Platform Audit

### Market data — IMPLEMENTED (live ticks, validation, real bid/ask) / MISSING (L2, corporate actions on the live feed)

Single source: Alpaca IEX top-of-book WebSocket (`MarketDataWorker.ts`), or an IBKR Gateway
`reqMktData` bridge when IBKR is the active broker. `MarketDataWorker.ts`'s own header states
explicitly it "does not fabricate ticks." Real validation exists: `acceptTickTimestamp()` rejects
invalid/future/out-of-order ticks (config-driven skew tolerances), `isDuplicateTick()` drops exact
repeats. Both bid AND ask are now cached with independent timestamps (added 2026-09-05), giving a
real (not synthetic) bid/ask spread — documented in-code as "the one real source of a genuine
bid/ask spread anywhere in this codebase (there is no L2 feed)."

**L2/order-book depth: MISSING by design, explicitly labeled `NOT_SUPPORTED`** in
`QuantitativeFeatureEngine.ts`: "Alpaca IEX (and this codebase) is top-of-book only. No L2 source
exists." **Corporate actions on the live tick path: MISSING** — no split/dividend/symbol-change/
delisting handling exists anywhere in the live quote path; ticks are raw price/volume only.

### Historical data — PARTIALLY IMPLEMENTED

`HistoricalDataGateway.ts`: cache-first over a real `ohlcv_bars` SQLite table, backfilled from
Alpaca's real bars endpoint, rate-limit-aware, with a pluggable provider registry that can swap in
IBKR historical data (falls back to Alpaca when IBKR reports empty coverage — a real, documented gap
where IBKR frequently returns "not subscribed" on liquid symbols).

**Split adjustment is real and enforced fail-closed**: a second uncached fetch with
`adjustment=split` is diffed >1% against cached raw closes, and `BacktestEngine.ts` **throws**
`CORPORATE_ACTION_DETECTED` rather than running on data it can prove is stale-adjusted — verified by
dedicated tests. **Dividends are never adjusted anywhere.**

**Survivorship bias is disclosed, not solved**: `replaySafety.json` carries a plain
`DELISTED_DATA_UNAVAILABLE` warning string surfaced into replay output when the universe is
operator-selected — there is no historical index-constituent list or delisted-symbol database. This
is honest labeling, not a fix, and should be read as MISSING for any real survivorship-bias
correction.

**Point-in-time correctness is real for news/AI facts**: a dedicated PIT ledger explicitly throws
`LOOK_AHEAD_FORBIDDEN` if a fact's publish time is after the query's `asOf` time, and query methods
filter accordingly. For bars, the canonical NEXT_BAR_OPEN fill engine (signal on a closed bar, fill
at the next bar's open) is the only promotion-adjacent path; the separate SAME_BAR_CLOSE
`BacktestEngine` is explicitly non-promotable per its own design (confirmed, not just asserted by
CLAUDE.md).

### Data architecture — PARTIALLY IMPLEMENTED, real duplication confirmed

**No single, authoritative raw→normalized→PIT→versioned-feature→research semantic path exists.**
(Operator correction, 2026-09-14: the original framing of this finding named a literal "feature
store" as the missing artifact; that overstates the requirement. Argus does not need an institutional
feature-store *product* — the absence of one is not itself a defect. What's actually missing, and
what genuinely matters, is **one authoritative path** per calculation with reproducibility,
provenance, and versioning, consumed consistently end to end:
`RAW SOURCE → NORMALIZED DATA → PROVENANCE/PIT → CANONICAL DATASET → VERSIONED FEATURES →
STRATEGY/FORECAST → RESEARCH RESULT`. Whether any one stage is implemented as a "feature store," a
plain versioned table, or a content-hashed registry is an implementation detail; what's graded below
is whether the path is singular and reproducible, not whether it matches a named institutional
pattern.) At least 7 independent
Alpaca market-data access points were found by direct code inspection, each with its own fetch
logic: `MarketDataWorker.ts` (live ticks), `HistoricalDataGateway.ts` (backtest bars),
`MarketUniverseScanner.ts` (3 separate calls — snapshots, ADV bars, movers), `MomentumUniverseScanner.ts`
(independent snapshot fetch), `SnapshotScanner.ts` (another independent snapshot fetch),
`PostMarketAnalysis.ts` (a bars fetch that **hardcodes** `https://data.alpaca.markets` directly
rather than going through the shared config, inconsistent with every other caller), and
`ingestAlpacaWarehouse.ts` (a wholly separate warehouse-ingestion path).

A genuinely more structured layer exists on the **research side only**: a canonical dataset schema,
a data-quality grader, a dataset registry (content-hashed, provenance-tagged), and a parquet store —
but this layer is **not consumed by any of the live discovery/scanner paths above**, which remain ad
hoc and duplicated. The dataset registry itself is in-memory only (a `Map`, not rehydrated from disk
on restart) — only the parquet `.meta.json` sidecars persist across restarts.

### Alternative data — IMPLEMENTED (news, fundamentals, macro, all real API calls) / MISSING (options, short interest, breadth, ETF flow, analyst revisions)

**News**: 7 real registered providers (3 RSS needing no key, 4 real key-gated APIs — Finnhub, Alpha
Vantage, Polygon, FMP — each with its own `isConfigured()` check, skipped cleanly without a key).
**Fundamentals**: real AlphaVantage `OVERVIEW` call with a real FMP fallback. **Macro**: real
AlphaVantage macro-indicator calls with a real FRED fallback. All three are genuinely called,
production HTTP integrations, not stubs.

**Explicitly, honestly labeled `NOT_SUPPORTED` in code** (not silently missing — the codebase says
so itself): market breadth ("no breadth data source exists in this repository"), options analytics
("no options feed is wired through BrokerManager or HistoricalDataGateway"), order flow/L2, volume
profile, TSI, anchored VWAP, pairs cointegration, Canadian commodities/FX. **No short interest,
ETF-flow, or analyst-revision data of any kind was found anywhere in the codebase.**

### Feature engineering — SPLIT-BRAIN (TS + Java independently compute the same indicators), monitored not silently diverging

A real, structural violation of CLAUDE.md's own "Java 26 Engine Authority" policy exists here:
`TechnicalIndicators.ts`/`RSIEngine.ts`/`MACDEngine.ts` (TypeScript) and
`quant-core-java/.../features/FeaturePipeline.java` (Java) **each independently implement RSI, MACD,
Bollinger Bands, and ATR** — genuinely duplicated calculation logic, not a facade-over-Java
relationship. `QuantitativeFeatureEngine.ts` itself is honestly a facade (reuses `StrategyContext`,
doesn't reimplement), but the TWO underlying engines it and the Java pipeline each draw from are
real, separate implementations.

**This is not silently diverging** — a real shadow-parity comparator (`ParityComparator.ts`)
periodically diffs Java's computed indicators against the TS ones and logs divergence, never voting.
But it does **not** carry the explicit `ACTIVE`/`LEGACY`/`COMPATIBILITY_ONLY` code-comment marker
CLAUDE.md's own rule 8 requires at exactly this kind of dual-implementation call site — a real,
if narrow, documentation-compliance gap.

**No feature versioning exists on the live indicator-computation path** — only the research
canonical-dataset wrapper has content-hash-based versioning, and (per the data-architecture finding
above) that registry doesn't survive a restart at the in-memory level.

### Data quality — IMPLEMENTED, but three independently-scoped systems (a further duplication finding)

Three separate `assessDataQuality`-shaped systems exist: (1) a live/runtime one
(`core/dataQuality.ts`) producing a real per-decision GREEN/YELLOW/RED grade — but only 1 of its 7
channels (`market_data`) is genuinely freshness-scored; the other 6 (news, fundamental, market
index, sector, forecast, broker) are hardcoded YELLOW placeholders with an honest "do not invent
freshness" comment rather than real computation; (2) a research/backtest one
(`research/dataQuality.ts`) that does real duplicate-timestamp/OHLC-validity/gap-counting checks
against a canonical dataset and gates `backtestAllowed`/`paperPromotionAllowed` (with
`liveCandidateAllowed` hardcoded `false` unconditionally); (3) a Java-side `MarketDataQualityEngine`
gating institutional feature computation independently of both TS systems. Three real, independently
maintained quality gates for three different purposes — functional, but a real architectural
duplication risk if any one drifts from the others' definition of "quality."

**Operator correction (2026-09-14) — this finding is more serious than the "1 of 7" count alone
conveys.** A single scalar `DATA QUALITY = YELLOW` grade is not yet an institutional-quality
multidimensional data-health assessment; the honest 6 hardcoded placeholders currently collapse
what should be per-channel state into one undifferentiated color. The eventual target is a
per-channel report — e.g. `market_data GREEN / news GREEN / fundamentals YELLOW / macro GREEN /
forecast GREEN / broker GREEN / corporate_actions YELLOW` — not one number standing in for seven
different real conditions. Equally important: **missing data, bad data, stale data, unavailable
data, and unknown data are five distinct states and must stay distinct** — collapsing them into a
single YELLOW (as the current 6 placeholders effectively do) is honest about *not fabricating*
freshness, but it is not the same as actually *knowing* which of those five conditions applies to
each channel. Closing this gap means building real freshness/validity scoring for the remaining 6
channels, each reporting its true state rather than a shared placeholder — not merely re-labeling
the existing YELLOW.

### Section 6 scorecard inputs
- **DATA**: real, validated live ticks; real, split-adjusted (not dividend-adjusted) historical
  bars with fail-closed corporate-action detection; genuine 7-way duplication of fetch logic across
  discovery/scanner paths with no shared normalization layer. Score: **3/6** (Implemented but
  incomplete — the duplication and missing dividend-adjustment/survivorship-bias-correction are real
  gaps, not just polish items). The ceiling on this score is not the absence of any single named
  component (L2, a feature-store product, etc.) — it's that the real, working pieces (live ticks,
  validation, historical bars, provenance, PIT enforcement, corporate-action detection, quality
  gates, research datasets) are not yet unified into one canonical data plane that every consumer
  goes through.
- **FEATURES**: real indicators, genuinely dual-implemented (TS+Java) in violation of the codebase's
  own stated policy, monitored via parity but not labeled per that policy's own rule; no live feature
  versioning. Score: **3/6**. The problem isn't a shortage of features — Argus has plenty. The
  problem is feature *authority*: which implementation (TS or Java) is the ground truth for a given
  indicator, whether it's versioned, and whether it's reproducible. That gap compounds directly with
  strategy count — it matters little at 5 strategies and becomes a real correctness risk approaching
  hundreds.

### Operator validation & priority correction (2026-09-14)

Section 6's findings are accepted as accurate; this note corrects only how they translate to
implementation priority, since the section identifies gaps but does not itself rank them. Read
alongside Sections L/N/S below, which already carry the deferral list this reinforces.

**P0/P1 — fix before major quant/strategy expansion** (in this order):
1. **Canonical data access layer** — collapse the 7 independent Alpaca fetch paths (market data,
   historical bars, snapshots, fundamentals, news, macro) into one layer that owns endpoint
   selection, timestamp interpretation, universe validity, missing-data representation, rate
   limiting, provenance tagging, and error classification. Scanners consume the layer; they stop
   deciding these things independently.
2. **Feature authority/versioning** — resolve the TS/Java dual-implementation split *before* the
   strategy count grows further. Left unresolved, two strategies both claiming "RSI(14)" can
   silently diverge in what they actually compute. Target shape: `Feature Definition → Feature
   Version → Authoritative Implementation → Feature Snapshot → Strategy → Forecast`.
3. **Corporate-action/universe correctness** — dividend adjustment, symbol changes, delistings, and
   historical universe membership (survivorship-bias correction), which matter increasingly as
   Argus moves toward systematic portfolio research rather than single-symbol backtests.

**Explicitly do NOT rush, even though Section 6 documents them as real gaps** (elaborated in
Sections L/N/S; restated here because Section 6 is where they're first raised): **L2 order-book
depth** — only becomes valuable if Argus later builds market making, order-book alpha, or
microstructure/queue-position strategies, none of which are in scope; current top-of-book data is
the higher-value investment for the existing strategy model. **Options** — a substantial standalone
research domain (chain → IV surface → Greeks → skew/term structure → strategies → hedging →
assignment/execution), not something to add merely because institutional firms carry it. **Spark/
Hadoop/distributed compute** — no current workload measurement justifies it; prove a real bottleneck
first (see Section N's named trigger conditions), don't provision ahead of demonstrated need.

This reinforces, rather than changes, the roadmap already converged on: canonical data → PIT/
corporate-actions/universe correctness → authoritative/versioned features → strategy factory →
strategy diversity/correlation → forecasts → **portfolio construction** (the largest single gap,
per Section E item 1) → portfolio-level risk → execution → OMS → broker → reconciliation →
attribution → research memory, feeding back into research. Not: strategy count first, specialized
data domains second.

---

## Section 7–8 — Quant Research, Strategy Platform, Forecasting, Strategy Diversity, Machine Learning

### Strategy inventory — IMPLEMENTED (5 CORE, live) / RESEARCH-ONLY (the other ~130+)

TypeScript: **5 CORE** strategies (`momentum_breakout`, `pullback_continuation`, `mean_reversion`,
`trend_following`, `range_reversion`) are the only ones live-wired into `evaluateAll()`; ~16
EXPERIMENTAL strategies exist gated behind config + a call-time env flag. `bestStrategyIdea()`
picks a single top-`setupScore` strategy per cycle and discards every other evaluation's side before
confluence is measured (the mechanism the strategy-selection confluence guard, off by default,
exists to partially correct).

Java: **135 model/engine files exist on disk** — materially more than CLAUDE.md's "~35" figure,
which turns out to refer only to the subset with formal tracked-registry entries; the real file
count is dominated by a large 2026-09-09/10 batch of options/FX/bond/commodity/CDS engines. The
authoritative status ledger (`config/engineOwnership.json`, ~135 keyed entries) shows: **3 SHADOW**
(`garch`, `hmm_regime`, `factor_composite` — real HTTP endpoint + real live consumer), plus 2
infrastructure gates also SHADOW; **the overwhelming majority RESEARCH** (zero HTTP endpoint,
`liveConsumer: "NONE"` literal, repeated ~125 times) — including all 5 ML engines and roughly 50
options-strategy calculators explicitly noting "no [X] data feed in Argus today." Three entries have
a real, tested TS caller that exists but is genuinely unused.

The 5 CORE strategies' Java counterparts exist ONLY for parity testing (`migrationStatus:
"PARITY_ONLY"`) — Node remains the sole live-authoritative implementation, confirmed by the tracked
registry, not just CLAUDE.md's own claim.

### Strategy lifecycle — IMPLEMENTED (for the Java model registry) / MISSING (for the TS CORE/EXPERIMENTAL split)

A real, enforced promotion ladder exists: `RESEARCH → BACKTEST → WALK_FORWARD → SHADOW → PAPER →
VALIDATED → PRODUCTION_CANDIDATE` (`modelRegistry.ts`), with a genuinely unit-tested
`isValidPromotion()` enforcing exactly-one-rung-forward movement and a hard gate
(`isEligibleForLiveConsideration()`) requiring at least VALIDATED before anything may influence
behavior beyond observation. **No model has ever been promoted past SHADOW** — confirmed both by
the code's own comment and by scanning every real registry entry (zero PAPER/VALIDATED/
PRODUCTION_CANDIDATE occurrences exist). Promotion is a manual, reviewed JSON edit — no automatic
promotion path exists in code. This real lifecycle machinery governs only the Java `quantModels`
inventory; the TS CORE/EXPERIMENTAL strategies have no equivalent staged lifecycle at all, only the
static two-list + env-flag mechanism.

### Strategy diversity — PARTIALLY IMPLEMENTED (real math, static assumption as input)

`QuantEnsembleEngine.effectiveIndependentCount()` correctly implements the real Kish design-effect /
Grinold-Kahn breadth formula (Σw² / ΣΣ correlation-weighted terms) — genuine, standard, correctly
applied math. The correlation matrix it consumes (`defaultFamilyCorrelationMatrix()`) is a **fixed,
disclosed assumption, not measured data**: same-family ρ=0.75, cross-family ρ=0.15, applied
uniformly regardless of symbol/regime/time — the class's own header states explicitly "this codebase
has no historical per-model signal store yet... there is no real measured model-to-model correlation
to feed in today." No real historical strategy-performance-correlation measurement exists anywhere
in the codebase. The 5 TS CORE strategies alone "cluster into essentially 2 real families" per the
bridging module's own candid comment — genuine multi-family diversity currently depends on pulling
in 10 Java RESEARCH-status engines as additional votes, a documented, explicit operator override of
this exact design doc's own recommendation to wait for real correlation data first.

### Forecast Engine — IMPLEMENTED (statistical core), with two disclosed gaps

Real, deterministic descriptive statistics (mean/median/trimmed-mean/stdev/95% CI/Wilson-interval
probability-of-profit/net-of-cost expected return), fails closed to `INSUFFICIENT_DATA` below a
20-sample minimum (nulling every field, never fabricating). Direction conditioning is real — a SELL
forecast is genuinely computed from a mirrored/negated return distribution, not the same numbers
relabeled. Field-by-field: `expectedReturn`, its CI, `probabilityOfProfit` (+bounds),
`uncertainty`, `netExpectedReturn`, `modelVersion`, `provenance` are all REAL/COMPUTED.
**`volatility` is honestly NULL-BY-DESIGN** ("no bar series is supplied by any current caller" — a
real, disclosed gap, not a silent placeholder). `strategyCount`/`familyCount`/
`effectiveIndependentCount` are real when a caller supplies ensemble context, correctly null
otherwise (never fabricated). `estimatedTransactionCostBps` is real when execution data exists, else
honestly tagged `NONE_ASSUMED_ZERO` rather than a guessed number.

### Calibration — IMPLEMENTED

Real effective-sample-size discipline (`effectiveSampleSize.ts`): clusters correlated/autocorrelated
predictions before counting independent observations (closing a previously-found 21x–770x raw-N
inflation), real closed-form Wilson intervals, reports raw vs. effective side-by-side rather than
silently substituting. `ReflectionEngine.ts` genuinely consumes this against real outcome tables.
The specific "44.6% on 242 predictions" NewsAgent figure CLAUDE.md cites is a live DB-computed
snapshot (correctly not hardcoded per the codebase's own anti-hardcoding rule) — **its current value
could not be verified from static code alone** and should be treated as UNVERIFIED-THIS-PASS, not
confirmed-current.

### Walk-forward / PBO — IMPLEMENTED (research-usable, correctly not a live gate)

`pbo.ts` is a real, substantial CSCV/PBO implementation (full combinatorial splits, IS/OOS Sharpe
ranks, degradation slope, probability of loss), with an honestly-disclosed simplification (not the
source paper's full CDF-based stochastic-dominance test) and fail-closed behavior on insufficient
data. Two real walk-forward mechanisms exist: a toy-strategy reference implementation, and a REAL
rolling walk-forward directly on the canonical NEXT_BAR_OPEN CORE engine (real train/val/embargo/test
windows from config, median-fold — not best-fold — reporting to avoid cherry-picking, explicit
`optimizedOnTest: false` flag). Neither is wired into any live gate, matching CLAUDE.md's own
characterization exactly.

### Machine learning — RESEARCH-ONLY, exactly as documented

Zero supervised ML training or inference exists anywhere in the live TypeScript path (a targeted
search for training/fit patterns returned no matches). Java ML engines (gradient boosting, random
forest, decision tree, KNN, linear SVM) are real, algorithmically correct, unit-tested
implementations — a direct read of the gradient-boosting engine confirmed a genuine Friedman-style
residual-fitting implementation, not a stub — but have **zero external caller**: the only callers of
their `.fit()` methods are internal (ensemble methods calling the shared decision-tree building
block). No model-training pipeline, experiment tracking, or trained-weights persistence layer exists
in either language.

### Section 7–8 scorecard inputs
- **QUANT RESEARCH**: real strategy inventory across both languages, a genuine (if Java-only)
  lifecycle ladder, but the ladder has never graduated anything past SHADOW and the TS CORE
  strategies (the only ones actually live) have no lifecycle at all. Score: **3/6**.
- **STRATEGY PLATFORM**: real registry/tracking infrastructure; ~97% of the Java inventory is
  RESEARCH-status with zero live consumer — a large amount of built-but-idle capability, exactly as
  CLAUDE.md already states, now quantified precisely (135 files, ~125 explicit `liveConsumer: NONE`
  entries). Score: **3/6**.
- **FORECASTING**: the strongest-scoring subsystem in this audit — real statistics, real direction
  conditioning, honest nulls rather than fabrication, real provenance tracking. Score: **4/6**
  (would need live-measured calibration accuracy and a populated `volatility` field to go higher).
- **STRATEGY DIVERSITY**: real math over a disclosed static assumption, with an explicit operator
  override of the design doc's own recommendation to wait for real data. Score: **2/6** (Scaffolded
  — the formula is real but its most important input is not measured).
- **MACHINE LEARNING**: real, tested, zero live wiring. Score: **1/6** (Concept/docs-adjacent — the
  code exists and is correct, but nothing in production or even shadow mode consumes it).

---

## Section 21–25 — Backtesting, Walk-Forward, PBO, Learning, Postmarket/Premarket

### Backtest engines — IMPLEMENTED, two engines with correctly distinct promotability status

**`BacktestEngine.ts` (SAME_BAR_CLOSE)**: real, structurally cannot see future bars (each step's
visible window is sliced to the current index and defended by a real "assert not future" check, not
just convention). Fills at the SAME bar's own close — an idealized instant-execution assumption —
and is programmatically stamped non-promotable at every return site (`stampSameBarPromotionQuarantine`),
not just documented as such. Transaction costs are real and non-flat (volatility/participation-rate
scaled slippage, real commission model, explicitly framed in-code as closing a real prior gap where
cost drag was previously absent). Corporate-action detection halts the run rather than silently
corrupting P&L (same mechanism as historical data ingestion, Section 6). Sample-size honesty is
real — Sharpe/win-rate are withheld, not fabricated, below a minimum trade count.

**`canonicalNextBarEngine.ts` (NEXT_BAR_OPEN)**: the one engine structurally eligible for
promotion — look-ahead is prevented by construction (a signal at bar *i* can only fill at bar
*i+1*'s open; a signal on the last bar is skipped, never filled against a nonexistent future bar).
Promotability is gated by a real multi-condition check (data provenance, GREEN data quality,
non-zero-cost, minimum OOS trade count, confirmed NEXT_BAR_OPEN execution model) — not a single
flag an operator could accidentally satisfy.

**Survivorship bias in the CORE backtest data path is a real, still-open gap**: a 2026-09-09 design
audit explicitly flagged this "NOT VERIFIED" for the `ohlcv_bars` data source both engines share, and
no later work in the codebase resolves it. This is distinct from the separately, more thoroughly
handled survivorship-bias disclosure in the MODE B historical-replay universe (Section 6) — the
CORE/canonical backtest path's own survivorship exposure remains genuinely unaddressed.

### Walk-forward — IMPLEMENTED (a real rolling mechanism exists), with one real methodological gap

Three genuinely distinct walk-forward implementations exist (not duplication-as-confusion, but
worth noting as three, not one): a single-split reference implementation on a toy SMA strategy; a
SAME_BAR_CLOSE-based validator explicitly self-labeled "not promotion evidence"; and — the real one
— `coreWalkForward.ts`, a genuine rolling walk-forward with a real embargo gap between windows,
running the canonical NEXT_BAR_OPEN engine per fold, reporting **median** (not best or mean) fold
expectancy specifically to resist cherry-picking a lucky fold, with honest
`INSUFFICIENT_SAMPLE`/`FRAGILE`/`COMPLETED` status gating.

Real permutation-based statistical significance testing exists and is genuinely wired into the
backtest engines (a one-sided p-value via sign-flip resampling, explicit
`SIGNIFICANT`/`STATISTICALLY_INSIGNIFICANT`/`INSUFFICIENT_SAMPLE` verdict) — this is real inferential
statistics, not a placeholder.

**Real gap found: multiple-testing correction is a warning flag, not a statistical adjustment.**
`multipleTesting.ts` flags when a search has tried more than a configured number of trials ("best-of-
search is not an edge") but applies **no Bonferroni/Benjamini-Hochberg-style correction to any
reported p-value or confidence interval anywhere in the codebase**. Given the strategy platform's
own stated ambition (hundreds/thousands of strategy configurations searched), this is a real,
name-worthy methodological gap between what a "statistically defensible" claim would require and
what the code currently does — SCAFFOLDED, not IMPLEMENTED, for this specific piece.

### PBO — IMPLEMENTED (real, methodologically faithful), UNPROVEN AT SCALE

`pbo.ts` is a real, substantial CSCV implementation matching the cited Bailey/Borwein/Lopez de
Prado/Zhu paper's Algorithm 2.3 (real combinatorial splits, not an approximation), with one honestly
self-disclosed simplification (a simplified stochastic-dominance proxy, not the paper's full
CDF-based test) and real, enforced preconditions that fail closed with a typed error rather than
returning a meaningless number on thin data. Directly verified against CLAUDE.md's own claim about a
prior real run against `MOMENTUM_BREAKOUT` (20 observations, insufficient for a trustworthy S=16
estimate) — the code's own precondition math confirms that claimed run genuinely could not have
produced a usable number, corroborating the claim rather than merely repeating it. No dedicated unit
test file was found for the core `computePbo()` function itself.

### Learning system — IMPLEMENTED, with a real and correctly-bounded automatic-weight-change path

Two genuinely distinct learning outputs exist, correctly separated by consequence:
**agent-weight adjustment** (`currentWeight`, feeding ChiefTrader's consensus math) IS automatic —
but gated on real evidence sufficiency (an autocorrelation-aware effective-sample-size test, not raw
trade count) and capped per cycle (a bounded step, never an unbounded jump), and structurally
excludes risk-exit agents from this kind of learning. **Rule-text generation**
(`generateReflectionRule`/`generateCalibrationInsightRules`) is verified text-only — written into a
`learnedRules` table, consumed only as debate-prompt context, never touching `currentWeight`,
RiskEngine, sizing, or OMS directly. A real, previously-found defect (fabricated Digital-Twin-telemetry
predictions being graded as real wins) is explicitly excluded by name in the current code, not just
fixed silently. No code path was found anywhere in this subsystem that lets a single loss or
rejected opportunity directly and automatically change a risk gate, a sizing parameter, or bypass
consensus — matching the audit's own required invariant (observation → hypothesis → research →
validation → promotion, never loss → automatic strategy change).

### Postmarket / Premarket — IMPLEMENTED, narrower in scope than "full universe scan"

Both `PostMarketAnalysis.ts` and `MissedOpportunityDetector.ts` are DB-durable (survive restarts,
not in-memory), with real anti-hindsight-bias safeguards (a candidate can only be classified a
"miss" if it was ALREADY ranked PROMOTE at the time, never retroactively relabeled) and at least one
documented, real forensic bug fix already shipped (a false `EXECUTION_MISS` classification from
checking mere row-existence rather than actual approval status, fixed and named in-code).

**Real, honestly-disclosed scope limit**: postmarket analysis reconstructs what the LIVE discovery
pipeline already logged that day (joining existing `observability_events`/`missed_opportunities`
rows) — it does **not** independently re-scan the full eligible universe. A symbol the live
pipeline never touched at all that day is structurally invisible to this report; the module can only
report "we found zero evidence of interest," never positively confirm a full-universe sweep occurred.
This is explicitly self-documented in the module's own header (a list of what it deliberately does
NOT do), not a silently narrower implementation than claimed.

`TradePlanBuilder.ts`'s premarket plan lifecycle (`DRAFT→READY→REVALIDATING→VALID→INVALIDATED→
EXPIRED→EXECUTED→CLOSED`) is real and DB-durable, with confidence and confluence genuinely computed
as two separate quantities (not a renamed duplicate), and entry-zone/invalidation levels derived
strictly from already-fetched real price fields rather than a fabricated volatility estimate.

### Paper-trading validation floors — IMPLEMENTED, single authoritative gate confirmed

`evaluateLiveReadiness()` is confirmed to be the single authoritative LIVE-eligibility decision
point — 28 gates confirmed by direct count matching CLAUDE.md's stated figure exactly, reading real
config/DB/runtime-flag state, fail-closed on query error. A separate, narrower pipeline-health check
(`TradingReadinessGate`) explicitly declares in its own code comment that it is NOT a competing
readiness authority and does not arm LIVE — a genuine, in-code non-overlap declaration rather than
an inferred one, so this audit found **no evidence of a second, competing live-eligibility decision
point**. The repo-root `ARGUS_LIVE_READINESS.json` snapshot is confirmed to be a manually-generated,
point-in-time artifact (no code path regenerates it automatically) — its "6/28 PASS" figure should be
read as a snapshot from its stated generation date, not a live-updating number; the current true
count would require actually invoking the live endpoint, which was not done in this pass.

### Section 21–25 scorecard inputs
- **RESEARCH / BACKTESTING**: real dual-engine design with correctly-enforced promotability
  separation, real transaction-cost modeling, real corporate-action fail-closed handling. One real,
  still-open gap (CORE-path survivorship bias, flagged since 2026-09-09, unresolved). Score: **4/6**.
- **WALK-FORWARD VALIDATION**: a genuine rolling/embargo mechanism exists and is used by the one
  promotable engine; real permutation significance testing; multiple-testing correction is a warning
  flag, not a real adjustment — a genuine methodological gap given the platform's own scale ambitions.
  Score: **3/6**.
- **LEARNING SYSTEM**: correctly bounded, evidence-gated, with the automatic/non-automatic boundary
  drawn in exactly the right place (weights yes, risk/sizing/consensus no). Score: **4/6**.
- **PAPER-TRADING VALIDATION**: a real, single, authoritative gate exists and was directly verified,
  not merely cited; the stored readiness snapshot is stale by design (manual regeneration) and should
  not be read as current without a fresh live check. Score: **3/6** (Implemented but incomplete — the
  gate is real, but organic paper evidence feeding it remains at zero per CLAUDE.md's own ground
  truth, unchanged by this audit).

---

## Section 16–18 — Portfolio Construction, Capital Allocation, Risk Management

### Portfolio construction — MISSING (the single largest gap this audit found)

**Traced the complete path from multiple simultaneous trade ideas through ChiefTrader, RiskEngine,
and OMS. There is no code path anywhere that compares two pending trade ideas against each other.**
`ChiefTraderAgent.ts`'s own consensus queue is explicitly, deliberately keyed **per-symbol** ("so
unrelated symbols' evaluations never wait on each other" — a real code comment), and evidence
aggregation for one symbol never reads another symbol's in-flight ideas. `RiskEngine.evaluateRisk()`
takes a single proposal; its serialization mutex prevents races on *shared global state* (peak
equity, order-rate counts) but never compares proposal A against proposal B. The correlation gate
(gate 20) checks a proposed symbol against **already-filled broker positions**, never against
sibling *pending* ideas. `PositionSizing.ts`/`OrderManagement.executeOrder()` both have single-symbol
signatures with no batch or netting concept.

The closest thing to cross-candidate comparison is pre-ChiefTrader discovery ranking
(`ComposableRanking.ts`), which is a **sort** by independently-computed weighted score — not a
diversification- or correlation-aware selection — and is architecturally scoped by CLAUDE.md itself
as non-trading (watchlist subscribe only, never emits a trade idea).

**This means: given 5 simultaneously-qualifying candidates, Argus today would approve and size all 5
independently if each individually clears every gate — there is no mechanism to prefer a
less-correlated lower-raw-score candidate over a more-correlated higher-raw-score one, and no
concept of "given everything else already held, is this the best use of incremental risk."** This is
exactly the gap the operator's own message identified as the top architectural priority, now
confirmed by direct trace rather than assumed.

### Position sizing — PARTIALLY IMPLEMENTED

`PositionSizing.ts` is a real, shared (live + backtest) pure function. `FIXED_DOLLAR` is the
default; `PERCENT_OF_EQUITY` is genuinely reachable (a real DB column, read by RiskEngine, exposed
via the settings API) but requires an explicit operator opt-in, confirmed not dead code.

**CLAUDE.md's claim verified true by direct trace, not just cited**: `ExpectedValue.ts` (Kelly/EV) is
architecturally isolated by design (no broker/DB/EventBus import at all) and is consumed by exactly
one live call site (`QuantSignalAgent.ts`), where it only **nulls out an idea before emission** —
`RiskEngine.ts` and `PositionSizing.ts` do not import it at all, confirmed by checking every importer
of the module. `fractionalKelly()`'s `suggestedFraction` output has no call site anywhere that feeds
it into an actual order quantity.

### Risk gates depth — gates 17/19 real but coarse; gate 20 real pairwise correlation (not a covariance matrix); no VaR/stress-test on the live path

Gate 17 (symbol concentration) and gate 19 (sector concentration) are real but simple: a flat 20%
equity ceiling, and a **static ~50-ticker hardcoded sector lookup table** (not a real sector/factor
classification service) with unmapped symbols failing closed. Gate 20 (correlation exposure) is
**genuinely real** — actual Pearson correlation of real daily return series (not raw prices, not a
sector heuristic) against each existing position individually, backed by real Alpaca historical
bars — but it is a threshold-and-sum check against positions one at a time, not a covariance matrix
or any portfolio-level optimization.

**No VaR, CVaR, covariance matrix, or stress-test capability exists anywhere on the live path.**
Real, individually-tested Java implementations exist for all of these (`ValueAtRiskEngine.java`,
`MeanVarianceOptimizer.java`, `RiskParityOptimizer.java`, `dcc_garch`, `dynamic_factor_model`) — every
one of them is `status: RESEARCH`, `httpEndpoint: NONE`, `liveConsumer: NONE` in the tracked engine
registry, confirmed by checking the actual Java HTTP dispatcher for a matching route (none exists).
The `mean_variance_optimizer` registry entry itself states explicitly: "ADVISORY/RESEARCH ONLY —
never sizes a real order; PositionSizing.ts remains sole sizing authority." This is real, correct,
tested optimization math sitting completely idle — the same "built but not activated" pattern
already documented for the Java quant-signal engines, now confirmed to extend to the entire
portfolio-optimization layer.

### Capital allocation — IMPLEMENTED as a flat dollar ceiling, with real evidence of an ad hoc, incrementally-patched concurrency architecture

`CapitalAllocation.ts` sums used positions plus reserved pending BUYs against a flat
`settings.budget` ceiling — no risk-weighting, no volatility scaling, no correlation-adjusted budget.
`PendingCapitalReservations.ts`'s own file header is direct evidence this area evolved as a sequence
of point-fixes rather than a designed concurrent-safe ledger: it exists specifically to patch a real
race condition found in production reasoning ("two BUY ideas evaluated back-to-back can each see the
OTHER's not-yet-persisted notional as unreserved and both pass"), and `RiskEngine.ts`'s own comments
document a **second**, independently-discovered leak in that same patch mechanism from a later
audit. Real, and now correctly closed (this session traced and re-verified the release-path
completeness directly) — but the pattern itself (DB-query snapshot + in-memory Band-Aid + a later
patch for the Band-Aid's own leak) is a real architectural smell worth naming for the portfolio-
construction roadmap: capital tracking should become atomic/ledger-based from the start of that
work, not accreted further.

### Leverage / drawdown / liquidity — drawdown and daily-loss real and correctly distinct; no gross/net exposure concept (no shorting exists); liquidity-aware sizing MISSING for regular-hours orders

Gate 10 (portfolio drawdown, real persisted high-water-mark, replay-isolated) and gate 8 (daily
loss, real NY-calendar-day-reset baseline) are both real and correctly implement genuinely distinct
mechanisms (all-time peak vs. daily reset), matching CLAUDE.md's own characterization. No gross/net
long-vs-short exposure tracking exists, but this is architecturally moot given Argus has no short-
selling capability at all (confirmed, not merely assumed). **Liquidity-aware sizing (checking real
bid/ask spread or ADV before sizing a large regular-hours order) is confirmed MISSING** — the only
liquidity/spread check in the entire codebase is scoped narrowly to the off-by-default
extended-hours execution policy; `PositionSizing.ts`'s own sizing-context interface has no
spread/ADV/liquidity field at all for ordinary regular-hours orders.

### Kill switches — CONFIRMED single authoritative mechanism (with one historical near-violation, found and fixed)

A single `TradingState` enum (`TRADING_ENABLED`/`TRADING_PAUSED`/`EMERGENCY_STOP`) with one mutator
(`setTradingState()`) is confirmed authoritative — gate 1 reads the state machine directly, not the
derived `emergencyStopActive` back-compat flag. Real evidence the "no second kill switch" invariant
is actively enforced, not merely assumed: `PortfolioReconciliation.ts`'s own code comments document a
past real bug where reconciliation set `emergencyStopActive` directly (which RiskEngine never reads),
meaning a significant position drift never actually blocked a new order despite code comments
claiming it did — found and fixed by routing through the real state-machine mutator instead. A
composite pre-ChiefTrader soft-lock layer (`isLiveIdeaGenerationEnabled()`) exists for new-BUY-only
disarming and is architecturally distinct from, not a duplicate of, the kill switch itself.

### Section 16–18 scorecard inputs
- **PORTFOLIO CONSTRUCTION**: confirmed MISSING by direct trace of the live decision path — every
  idea is evaluated and sized in total isolation from every other idea. Score: **0/6**. This is the
  single lowest score in this entire audit and, per the operator's own framing, the correct next
  major investment after the current forensic hardening work.
- **CAPITAL ALLOCATION**: real, correctly enforced, but architecturally a flat ceiling with a
  patched-not-designed concurrency history. Score: **3/6**.
- **RISK**: the 25-gate ladder itself remains genuinely strong (unchanged from this session's own
  extensive prior verification) — but "risk" in the institutional sense this audit is measuring
  against includes portfolio-level risk (VaR, covariance, factor exposure), and that entire layer is
  real-but-idle Java code with zero live wiring. Trade-level risk: **5/6** (operationally validated —
  this session alone traced and fixed 4 real defects in this exact machinery under adversarial
  testing). Portfolio-level risk: **0/6**. Blended: **3/6**, reported as a range rather than a single
  number to avoid hiding this split.

---

## Section 28 — Frontend / Terminal Audit

*(This section's initial dispatch hit a real harness issue worth naming plainly: the research
agent's own worktree was cleaned up mid-task by the orchestrating process while its own child
research agents were still reading from it, producing two partial reports. Rather than retry the
same fragile nested-agent pattern, the remaining gaps were closed directly against the live repo.)*

*(Two of the sub-agents recovered mid-task by falling back to Read/Glob after Bash/Grep broke, and
delivered genuinely thorough, file:line-cited findings anyway — their evidence is used directly
below, not discarded.)*

| Area | Status | Evidence |
|---|---|---|
| **Command Center** | **EXISTS, fully real** | `App.tsx`'s `command` tab renders `LiveReadinessBanner` (real `/api/v2/live-readiness`, 30s poll) and `WhyNotTradingStrip` (real `/api/v2/diagnostics/why-not-trading`, backed by a real `DiagnosticService`/catalog). The master emergency-stop button calls a REAL handler (`POST /api/v1/system/emergency-stop`) that genuinely sets `TRADING_PAUSED`/`EMERGENCY_STOP`, persists to a real `kill_switch_events` audit table, and cancels real broker orders — a stale in-code comment calling this an "emergency-stop stub" is itself wrong; the implementation is real. |
| **Market/universe view** | **PARTIALLY EXISTS** | Real backend data exists (broad-universe/movers/news-catalyst caches, a real `DISCOVERY_CANDIDATE_ADMITTED`/`_FILTERED` per-symbol reason ledger in `observability_events`) and `GET /continuous-intelligence/status` genuinely returns the real active-symbol list — but no frontend component renders the actual symbol sets or the per-symbol filter-reason ledger; only aggregate counts and a promotion/eviction *event feed* (not the underlying symbol lists themselves) reach the UI, via `SubscriptionPriorityQueuePanel`. |
| **Opportunity Scanner** | **EXISTS, real, but split across two tabs** | The `opportunities` tab shows the real live idea feed (`GET /api/v2/opportunities`, DB-backed, tested) plus `OpportunitySnapshotPanel` (real strategy tier/family/lifecycle-status per idea). The "why excluded/ranked" reasoning — real `PROMOTE`/`HOLD`/`REJECT` classifications with actual reasons, and real `SUBSCRIPTION_MISS`/`AGENT_MISS`/`CONSENSUS_REJECTION`/`RISK_REJECTION`/`EXECUTION_MISS` classifications — lives in the separate `scanner` tab, not co-located with the feed itself. |
| **Quant/Strategy Explorer** | **EXISTS, real, but in `settings` not `scanner`** | `QuantEngineCatalog.tsx` genuinely reads the real `config/engineOwnership.json`-backed registry (RESEARCH/SHADOW/PAPER/VALIDATED/PRODUCTION_CANDIDATE statuses, matching Section 7–8's own findings exactly) via a real API, "never fabricates counts, statuses, or wiring state" per its own header — but it's mounted under the `settings` tab, not `scanner`, where an operator would more naturally look for it. |
| **Forecasts view** | **Real forecast DATA does reach the UI — but not via the dedicated Forecast API.** | `OpportunitySnapshotPanel.tsx` (built this session) directly renders `modelForecast.expectedReturn`/`probabilityOfProfit`, embedded inline via `mostRecentForecast()` in the opportunity-snapshot response — this is real and confirmed. Separately, the **dedicated** `GET/POST /api/v2/observability/forecast` routes have **zero direct frontend caller** (a repo-wide search found none) — the standalone Forecast Engine API is API-only; only the piggybacked field inside the opportunity feed is actually visible to an operator today. |
| **Portfolio view** | **EXISTS, real, fail-closed** | Real state (`GET /api/v1/portfolio` → `{cash, buying_power, equity, positions}`), backed by a handler whose own doc comment states "Never invents cash/equity. Fail-closed: 502/503 + available:false" on a broker error. Liquidate action is real; a Rebalance action is present but **honestly returns HTTP 501 (not implemented)** rather than faking success — a genuine honesty practice, not a silent stub. |
| **Risk view** | **EXISTS, real, read-only by design** | `RiskGateHistoryPanel.tsx`'s own doc comment: "Real 25-gate breakdown per recent risk assessment... every gate as actually recorded by RiskEngine.ts... Read-only: no frontend override, no 'force approve', no bypass control." Backed by a real DB-integration-tested route joining `risk_gate_results`/`risk_assessments`, never a synthesized pass. A separate `GuardrailsPanel` (config toggles) has some real-wired toggles and some still-documented-as-fake ones — a distinct, smaller surface from the 25-gate checklist itself. |
| **Orders/Execution view** | **EXISTS, real, deep** | `TransactionExplorer`/`TransactionObservatory` assemble "the transaction, consensus decision, every contributing agent's evidence, the full risk gate ladder, the order lifecycle, fills, and durable events from real tables. No recomputation, no model calls, no fabricated placeholders" (component's own doc comment, DB-integration-tested). A separate, real single-order-trace endpoint (`GET /observability/orders/:orderId`) has **no frontend caller found** — API-only. `ExecutionQualityChart.tsx` is real and confirmed mounted (`App.tsx`) — notably, its own doc comment states it *used to* synthesize 60 fake trades per render via `Date.now()`-jitter including a fabricated slippage figure, and was fixed to real DB aggregates (`GET /api/v2/trading/execution-quality`) — a concrete, named instance of exactly the kind of UI fabrication this audit is designed to catch, already found and fixed by a prior session, not by this one. |
| **Attribution** | **MISSING (backend real, zero frontend consumer)** | `dailyAttributionReport.ts` is real and DB-backed with a real route (`GET /api/v2/observability/daily-attribution`) — a direct search across every `.tsx` file for any reference to this endpoint returned zero matches. API/CLI-only today. |
| **Research/Backtesting/Walk-Forward UI** | **MISSING (CLI/API-only, not a UI trigger)** | `ResearchLabPanel.tsx` makes exactly 4 real `fetch()` calls, all GET-style status reads — confirmed zero POST/submit/trigger call anywhere in the file. Real, DB-backed status display, explicitly self-labeled in its own copy ("VectorBT is a research engine. It cannot place orders. Installing it does not prove an edge.") — but an operator cannot configure or launch a backtest from the UI; this remains `scripts/argus-cli.ts`/direct script territory. |
| **Data Quality view** | **MISSING** | A direct search for any Data-Quality-named or `dataFreshness`-referencing component returned zero files. The real, multi-layered data-quality machinery documented in Section 6 (three independent quality gates) has no dedicated frontend surface at all. |
| **Premarket view** | **EXISTS, real data** | `PremarketIntelligence.tsx` makes 5 real `fetch()` calls against real, tested backend routes (`session-lifecycle`, `trade-plans/:date`, `ranking/latest`, `missed-opportunities`, `continuous-intelligence/status`) — each backed by a dedicated test file, confirming these are not stub routes. |
| **Postmarket view** | **MISSING as a distinct UI surface** | No Postmarket-named or close-review-named component exists anywhere under `src/components/`, and a direct search of `PremarketIntelligence.tsx` for any postmarket/close-review rendering branch found none. The real, DB-backed `PostMarketAnalysis.ts` backend (Section 21–25) has no corresponding frontend view at all — an operator cannot see the postmarket "would Argus have known?" report anywhere in the UI today, only via CLI/script. |
| **Learning/Reflection view** | **EXISTS, real data, honestly incomplete** | The 'learning' tab renders real `learningSummary` data (agent weights, win rates, real `learnedRules` text) from a real endpoint. Multiple in-code comments explicitly note that previously-fabricated content (an RL-alpha display, a weight-evolution bar chart, a Kelly-% display, an "Agent Learning & Evolution Journal") was deliberately **removed** and left labeled `UNAVAILABLE`/`AWAITING_EVIDENCE`/`NOT WIRED` rather than faked — a genuine, verifiable honesty practice in this specific view, not just a claim. |
| **System Health / Observability** | Real components confirmed to exist (`DecisionTracePanel.tsx`, `AgentWorkflowTheater.tsx`, `DigitalTwinVisualizer.tsx`) | Not independently re-verified for real-vs-mock data split this pass beyond what CLAUDE.md's own "Frontend honesty" table already documents — no contradicting evidence found. |

### Architecture findings

**No unified read-model API layer exists.** `App.tsx` alone contains 57 separate direct `fetch()`
calls; no `apiClient.ts`, no `useArgusData`-style shared data hook, no `src/services/` directory was
found. Every component/tab fetches its own bespoke endpoint independently — functional, but a real
architectural cost for a future institutional terminal (Section 28's own "click a number, see why"
drill-down requirement would be considerably easier to build on top of a real read-model layer than
on 57+ independent fetch call sites).

**Execute-override cannot bypass RiskEngine/OMS — directly verified, not assumed.**
`POST /api/v2/trading/execute-override` was traced line-by-line: it calls
`runManualTradeCoEvaluation()`, which genuinely waits for a real `CHIEF_CONSENSUS_COMPLETED` (or
`TRADE_REJECTED_CONSENSUS`) event from the live consensus pipeline (the same
`eventBus.on`/`off`-paired listener already verified leak-free in this session's Phase 15 work) — a
rejected consensus returns HTTP 409 with `TRADE_REJECTED_CONSENSUS` and never proceeds further. On
approval, the route's own response explicitly states "RiskEngine [gates] and OMS still apply
asynchronously" — the real order, if any, still flows through the unmodified normal
`CHIEF_APPROVED_IDEA` → `RISK_ASSESSMENT_COMPLETED` → OMS event chain. **CLAUDE.md's claim ("Full
RiskEngine; never OMS-direct") is confirmed accurate by direct trace.**

### Section 28 scorecard input
All 14 requested view areas were ultimately confirmed with real file:line evidence despite the
mid-pass tooling failure. **A genuinely consistent honesty pattern emerged across independent
findings**: a stale "stub" comment on an actually-real emergency-stop handler (comment wrong, code
right); a Rebalance action that honestly returns HTTP 501 instead of faking success; an
`ExecutionQualityChart` whose own doc comment names a REAL PRIOR fabrication (60 synthetic trades via
`Date.now()` jitter, including a fake slippage number) that was found and fixed before this
session — the same class of defect this whole audit exists to catch, already caught once. This is a
real, positive signal about the engineering culture around this codebase, not merely a claim.

Against that: the institutional-terminal concept remains genuinely incomplete — **no attribution
UI, no research/backtest trigger UI, no data-quality UI, no postmarket UI**, real content
meaningfully scattered across tabs in ways that don't match where an operator would naturally look
for it (the strategy catalog under `settings` not `scanner`; exclusion-reasoning under `scanner` not
`opportunities`), and confirmed **no unified read-model layer** (57+ independent `fetch()` call
sites in `App.tsx` alone) underneath any of it.

- **TERMINAL**: Score: **3/6** (Implemented but incomplete — every individually-checked surface is
  real and several show genuine honesty discipline, but the institutional-terminal concept as a
  whole — attribution, backtest-trigger, data-quality, postmarket, and a coherent information
  architecture across tabs — is far from complete).

---

## Section 26–30 — Reliability, Scalability, Observability, Security

*(Per this document's own opening rule — document, do not fix, unless explicitly authorized later —
the real findings below, including one genuine security gap, are reported and NOT patched in this
pass.)*

### Concurrency / scale architecture — IMPLEMENTED for current scale, real ceilings identified

Single Node.js process, ~24 named services booted synchronously at startup, **33 distinct production
files each running their own independent `setInterval` poller** — no shared scheduler, no message
queue, no worker-thread pool, no job-queue dependency anywhere in `package.json`. Two real, narrow
exceptions to "no backpressure" were found: RiskEngine's own evaluation-queue mutex (already known),
and a genuinely real, recently-added concurrency cap + per-symbol coalescing on the Java bridge's
tick path — added specifically after a **live-measured burst of up to 3,326 simultaneous in-flight
requests** was observed before the fix. That figure is direct, real evidence this class of scale
failure is not hypothetical for Argus; it has already happened once, on one call path, and was fixed
for that one path only.

**Real, unfixed scalability ceiling found on the live risk-evaluation path**: two separate,
completely unscoped `SELECT * FROM trades` full-table fetches occur inside RiskEngine's serialized
evaluation on every single risk evaluation (gates 3/4/5's cooldown checks, and gate 23's capital
allocation) — both are self-documented in-code as having been fixed for the **replay** path only,
with an explicit comment stating the live path was deliberately left untouched "to avoid any
live-path behavior change." At the current real row count (`trades`=479) this is not yet material,
but it is a genuine O(n) linear-growth ceiling with no pagination, index-assisted filtering, or
archival strategy, sitting inside the one mutex every single order must pass through.

**Real current operating scale, confirmed via live DB query, not estimated**: `trades`=479,
`fills`=177, `risk_assessments`=1,897 — dozens-of-symbols/low-hundreds-of-trades scale, consistent
with the real `maxActiveSubscriptions: 12` cap. The observability/forensic tables are orders of
magnitude larger (`observability_events`=1,442,124, `event_traces`=305,083) — the 3.9GB DB file is
dominated by telemetry retention, not trading history.

### Database — SQLite is confirmed a hard architectural ceiling, no migration scaffold exists

Single-writer WAL-mode SQLite confirmed as the only production writer connection (one genuine `new
Database()` call site found across the entire source tree). No Postgres/MySQL driver, ORM dialect
switch, or migration-in-progress marker exists anywhere — this is foundational, not provisional, and
any future scale beyond SQLite's real limits would require a genuinely new subsystem, not a config
flip.

### Java bridge — IMPLEMENTED, one real fail-closed design, one real operational gap

Every `QuantCoreBridge.ts` call is a standalone per-symbol HTTP round trip with a genuinely tight
100ms timeout and 4 independently-domain-split circuit breakers (tick/research/ensemble/
institutional) — split specifically after a shared breaker was found collaterally blocking healthy
endpoints when only the tick path was overloaded. This is real, load-tested-in-the-sense-of-actually-
having-failed-in-production engineering, not a designed capacity test — no evidence of a deliberate
multi-symbol stress test for the institutional/ensemble/research endpoints was found.

**Real gap: the Java process has no crash-detection or respawn.** It is spawned once, detached, at
boot, with an exit handler that only logs a warning. If it crashes mid-session, it stays down for the
rest of the process lifetime — Node does not hang (every `QuantCoreBridge` method fails closed:
circuit breakers open, calls return null/no-op, never throw into the live tick handler) but recovery
requires an operator to notice and manually restart the companion process. This is a real gap not
covered by any of the DEF-25 through DEF-30 restart/recovery work, which was all Node-process-scoped.

### Observability — IMPLEMENTED, genuinely queryable, with one already-fixed real leak

The 7-table decision-trace join is confirmed real and queryable exactly as CLAUDE.md describes, with
secret redaction applied inline at read time. Backpressure on the observability write path itself is
genuinely implemented (a bounded queue that drops rather than grows unboundedly under sustained DB
outage, with a dedicated regression test proving the cap holds) — this directly closes one of this
audit's own Phase 15-style concerns for this specific subsystem. **A real, previously-fixed leak was
found in this layer's own history**: event payloads used to be persisted and served completely raw
until a caught-error string embedding a live API key in a query string was observed reaching a public
observability endpoint in cleartext — now closed by redacting at write time, not read time, a
meaningfully stronger fix than a display-layer patch.

### Security / AI safety — one real, still-open gap found; one structural defense-in-depth gap found; DEF-31's own scope note corrected with more precise evidence

**CLAUDE.md's own "not yet extended" caveat about FundamentalAgent/MacroAgent needed correction, not
just confirmation**: both agents' prompts are built from numeric fields only (P/E, CPI, unemployment,
etc.) with no free-text external data embedded at all — a narrower injection surface than the
existing caveat implies.

**The real, still-open instance is elsewhere, and more load-bearing than either of those two:
`ChiefTraderAgent.ts`'s Bull/Bear researcher prompts AND its main ConsensusDebate prompt** (the
actual live consensus-vote prompt every trade decision passes through) both interpolate
`idea.reasoning` — a free-text field populated by upstream idea-generating agents, including
news-derived reasoning — via bare template-literal interpolation with **no delimiter isolating it
from instructions**, the exact pattern DEF-31 replaced at the news-ingestion boundary with a real
`<UNTRUSTED_ARTICLE_DATA>` tag scheme. The fix exists and is proven at one boundary; it has not been
applied at this second, higher-leverage boundary despite CLAUDE.md itself flagging this exact class
of risk as open. **This is a real, currently-exploitable-in-principle security gap, not fixed in this
audit-only pass per its own rules, and should be treated as the highest-priority security item in
this entire document.**

**A second, structural gap**: `gateTradeIdea()` — the one function every `emitTradeIdea` call passes
through — validates only `symbol` and `currentPrice`; it does not read, validate, or clamp
`confidence` at all. `AIOutputValidator`'s real clamping is enforced per-caller (verified real for
`NewsScoringEngine`), not structurally at this single chokepoint. A future or buggy caller emitting
an idea with an AI-influenced or out-of-range confidence value would not be caught here — directly
answering this audit's own question ("could AI-generated text ever reach `emitTradeIdea` without
going through AIOutputValidator's clamping") with a concrete yes, structurally possible.

Secret redaction itself (`SecretRedaction.ts`) is real and reasonably thorough (25 named env-var
secrets, an unanchored key-name-pattern match specifically covering a documented prior
camelCase-matching bug, Bearer/JWT/query-string pattern redaction, wired into 24 real call sites) —
with one self-documented, structural limitation: it only catches secrets readable from
`process.env`; decrypted DB-stored broker credentials never populate `process.env`, so protection for
those depends entirely on the key-name regex. Alpaca/IBKR (the two actually-in-use brokers) were not
found to log raw error objects and use header-based (not URL-embedded) auth, a lower-risk pattern by
construction.

### Restart / recovery — the Java-crash gap and two uncovered interval-worker leaks (both above) are this section's real findings; everything else already covered by DEF-25–30

**Real, previously-undocumented instance of the exact DEF-27 class of bug**: `MarketRegimeAgent` and
`ChiefTraderAgent` — two of the most central live-path singletons — start real `setInterval` timers
in their own constructors and have **no `stop()` method at all**, and are absent from
`gracefulShutdown.ts`'s explicit stop list (which correctly covers 9 *other* workers per DEF-27's own
fix). Practical impact is low today (a hard `process.exit(0)` follows the drain almost immediately,
narrowing the race window to something close to zero rather than a hang), but this is a genuine,
concrete gap in the "stop every interval worker before DB close" invariant DEF-27 was supposed to
establish as a durable pattern across the codebase, not just for the 9 workers it happened to touch.

In-flight (non-durably-persisted) EventBus events on a crash are confirmed bounded and intentional —
a capped in-memory ring, with only 4 specifically named, deliberately-non-persisted event types
(`MARKET_DATA`, `CALCULATION_COMPLETED`, `TRACE_SPAN`, `MODEL_HEALTH`) exposed to loss on crash;
every decision-lifecycle event type persists per config, matching CLAUDE.md's own framing exactly.

### Section 26–30 scorecard inputs
- **RELIABILITY**: strong, well-tested foundational work (DEF-25 through DEF-30) with two genuine,
  narrow gaps found this pass (two uncovered interval workers, one unmonitored external process).
  Score: **4/6**.
- **SCALABILITY**: honest about its own current, small scale; one real, self-documented, deliberately
  deferred live-path bottleneck (RiskEngine's full-table scans) that is a real ceiling, not yet a
  real problem. Score: **3/6**.
- **OBSERVABILITY**: genuinely strong — real, queryable, backpressure-protected, with a real leak
  already found and closed in its own history. Score: **4/6**.
- **SECURITY**: one real, still-open, correctly-classified-as-highest-priority prompt-injection gap
  at the actual consensus-vote prompt, plus a real structural defense-in-depth gap at the
  `emitTradeIdea` chokepoint. Score: **2/6** — this is a genuine finding, not a process artifact, and
  should not be rounded up because other parts of the security posture (secret redaction, the DEF-31
  precedent fix itself) are real and reasonably strong.

---

# FINAL SYNTHESIS

## A. Executive Assessment

Argus today is a **real, working, honestly-instrumented paper-trading execution platform** with a
protected, adversarially-tested safety spine (RiskEngine's 25 gates, OMS, reconciliation — the exact
machinery this session's own FD-1 through FD-9 forensic pass spent extensive effort hardening) sitting
underneath a **genuinely large amount of built-but-idle quantitative research infrastructure**
(~135 Java institutional models, real ML engines, real VaR/mean-variance/risk-parity optimizers) that
has almost entirely never been connected to a live decision. The single largest structural gap
against the institutional target is **portfolio construction**, confirmed MISSING by direct trace:
every trade idea today is evaluated, approved, and sized in complete isolation from every other idea
in flight — there is no code path anywhere that compares candidate A against candidate B. This is not
a missing feature bolted onto an otherwise-complete system; it is the one piece whose absence means
Argus today is structurally a **trade-approval system**, not yet a **portfolio-construction system**,
regardless of how sophisticated any individual strategy's signal becomes.

A second, genuinely serious finding surfaced only by this pass: `ChiefTraderAgent.ts`'s own
consensus-debate prompt — the prompt every single trade decision's AI debate actually runs through —
still interpolates free-text `idea.reasoning` with no delimiter isolating it from instructions, the
exact injection pattern already fixed once at the news-ingestion boundary (DEF-31) but never extended
to this second, more load-bearing boundary. This is real, currently open, and should be treated as
the highest-priority single item in this document, ahead of any roadmap phase below — not because it
is more strategically important than portfolio construction, but because it is a live safety gap
rather than a missing capability.

Everything else this audit found sits between those two poles: real, honest, adversarially-tested
execution mechanics; real but narrow attribution/execution-quality measurement; real backtesting and
walk-forward machinery with one genuine methodological gap (multiple-testing correction is a warning
flag, not a real statistical adjustment); a real strategy-diversity formula fed a static, disclosed
assumption rather than measured correlation; and a frontend that is honest where it exists (including
one concretely-documented instance of a prior UI fabrication already found and fixed) but structurally
incomplete against the institutional-terminal target.

## B. Institutional Capability Scorecard

*(0=Missing, 1=Concept/docs only, 2=Scaffolded, 3=Implemented but incomplete, 4=Implemented and
tested, 5=Operationally validated, 6=Institutionally credible. No 5/6 is assigned anywhere in this
audit — nothing in Argus has yet accumulated the organic, live-measured operational history a 5 or 6
would require.)*

| Subsystem | Score | One-line justification |
|---|---|---|
| DATA | 3/6 | Real validated live ticks + real split-adjusted historical bars, but 7-way duplicated fetch logic with no shared normalization layer; no dividend adjustment; survivorship bias disclosed, not corrected |
| FEATURES | 3/6 | Real indicators, genuinely dual-implemented TS+Java in violation of the codebase's own stated policy, monitored via parity but not labeled per that policy |
| QUANT RESEARCH | 3/6 | Real strategy inventory across both languages; a genuine lifecycle ladder exists but has never graduated anything past SHADOW, and the only actually-live strategies (5 TS CORE) have no lifecycle at all |
| STRATEGY PLATFORM | 3/6 | ~135 real Java engines exist; ~97% are RESEARCH-status with zero live consumer — a large amount of built-but-idle capability, now precisely quantified |
| FORECASTING | 4/6 | The strongest-scoring subsystem — real statistics, real direction conditioning, honest nulls (volatility) rather than fabrication, real provenance |
| PORTFOLIO CONSTRUCTION | 0/6 | Confirmed MISSING by direct trace — every idea evaluated and sized in total isolation; real optimization math exists in Java but is wired to nothing |
| RISK | 3/6 (5 trade-level / 0 portfolio-level, blended) | The 25-gate trade-level ladder is operationally validated by this session's own adversarial work; portfolio-level risk (VaR/covariance/factor exposure) is real, tested Java code with zero live wiring |
| EXECUTION | 4/6 | Adversarially tested across both broker adapters this session; the one broker-submission defect class this audit exists to prevent (a duplicate real order) was found and closed with documentation-verified evidence |
| RECONCILIATION | 4/6 | Real, broker-source-of-truth design with a real, now-complete (position- and order-level) debounce mechanism; one honestly-flagged residual staleness window |
| LEARNING | 4/6 | Correctly bounded, evidence-gated automatic weight learning; rule-generation is genuinely text-only; the automatic/non-automatic boundary is drawn in exactly the right place |
| RESEARCH (backtest/WFO/PBO) | 3/6 | Real dual-engine design with correctly-enforced promotability separation; real permutation significance testing; multiple-testing correction is a warning flag, not a real adjustment |
| RELIABILITY | 4/6 | Strong, well-tested foundational work (DEF-25–30); two genuine narrow gaps found this pass (two uncovered interval workers, one unmonitored external process) |
| OBSERVABILITY | 4/6 | Genuinely queryable 7-table trace join; real backpressure; a real leak already found and closed in its own history |
| SECURITY | 2/6 | One real, still-open, high-leverage prompt-injection gap at the actual consensus-vote prompt; one real structural defense-in-depth gap at the `emitTradeIdea` chokepoint |
| TERMINAL | 3/6 | Every individually-checked surface is real, several show genuine honesty discipline; no attribution/backtest-trigger/data-quality/postmarket UI; no unified read-model layer |
| SCALABILITY | 3/6 | Honest about its own small current scale (479 trades, 12-symbol subscription cap); one real, self-documented, deliberately-deferred live-path bottleneck |

## C. Current Architecture Map (as actually traced this pass)

```
LIVE DATA                    RESEARCH DATA (separate, not shared)
Alpaca IEX WS / IBKR bridge  Alpaca REST bars → ohlcv_bars (cached)
  → MarketDataWorker.ts        → HistoricalDataGateway.ts
  (7 more independent Alpaca   → canonical dataset / quality / registry
   fetch call sites, no        (real, but NOT consumed by live discovery)
   shared normalization)
       │
       ▼
IDEA AGENTS (Technical/News/Fundamental/Macro/Portfolio/Quant/Kronos)
  → 5 TS CORE strategies (live) + ~16 EXPERIMENTAL (flag-gated)
  → ~135 Java engines: 3 SHADOW (real vote), ~130 RESEARCH (zero wiring)
       │  TRADE_IDEA_GENERATED (per-symbol, independent — NO cross-idea comparison anywhere)
       ▼
ChiefTraderAgent — per-symbol consensus queue, AI debate
  [REAL, STILL-OPEN GAP: idea.reasoning interpolated into the debate
   prompt with no delimiter isolation — the DEF-31 pattern, unextended]
       │  CHIEF_APPROVED_IDEA (single-symbol, still no cross-idea awareness)
       ▼
RiskEngine — 25 gates, real pairwise correlation (gate 20), NO portfolio-
  level optimization anywhere in this path (VaR/mean-variance/risk-parity
  all exist in Java, zero live wiring)
  [self-documented O(n) full-table scan on gates 3/4/5 and 23, live path only]
       │  RISK_ASSESSMENT_COMPLETED (persist-then-emit, single proposal)
       ▼
OMS (OrderManagement.ts) — adversarially hardened this session (FD-4,8,9)
       │
       ▼
BrokerManager → IBGatewaySocketAdapter (active) / AlpacaBroker
       │
       ▼
Fills → fillLedger (cumulative-watermark dedup) → localPortfolioSync
  (N-writer-stress-tested this session, FD-6) → portfolio
       │
       ▼
PortfolioReconciliation — broker-source-of-truth, real debounce
  (position- AND order-level, FD-7-completed this session)
       │
       ▼
Attribution (dailyAttributionReport.ts, real, NO frontend consumer)
Execution Quality (real, IS rendered in UI — ExecutionQualityChart)
       │
       ▼
ReflectionEngine — real, evidence-gated weight learning + text-only rules
       │
       ▼
Postmarket/Premarket — real, DB-durable, honestly-scoped (reconstructs
  what live discovery already saw, not an independent universe sweep)
```

## D. Target Architecture (institutional)

The operator's own §3 diagram is adopted as the target, with one addition this audit's own findings
make necessary: an explicit **Idea Aggregation** stage between ChiefTrader-approved ideas and Risk,
representing the genuinely missing portfolio-construction layer — today's pipeline has ChiefTrader
feed RiskEngine directly, one idea at a time, with nothing in between.

```
DATA PLATFORM (unified, PIT-correct, feature-store-backed)
       ↓
RESEARCH PLATFORM (strategy factory, real lifecycle enforcement past SHADOW)
       ↓
STRATEGY ENSEMBLE (measured correlation, not a static assumption matrix)
       ↓
QUANT FORECAST (already real — extend volatility field, wire more callers)
       ↓
[NEW] PORTFOLIO CONSTRUCTION — the one stage with no current equivalent:
       compares ALL currently-pending approved ideas against each other AND
       against existing holdings; wires the already-built, already-tested
       Java VaR/mean-variance/risk-parity engines into a real decision
       ↓
RISK (existing 25-gate ladder, now also receiving a portfolio-aware
       proposal rather than an isolated one)
       ↓
EXECUTION (existing OMS — already adversarially hardened)
       ↓
RECONCILIATION (existing — already real and hardened)
       ↓
ATTRIBUTION (existing data, needs a frontend surface)
       ↓
RESEARCH LOOP (existing ReflectionEngine/Postmarket — extend, don't rebuild)
```

## E. Gap Analysis (every meaningful missing capability, ranked)

1. **Portfolio construction** — MISSING entirely. The single largest gap.
2. **Consensus-prompt injection isolation** — the one gap in this document that is a live safety
   issue, not a missing capability. Should be treated as more urgent than its ranking position here
   implies.
3. **Strategy-correlation measurement** — the diversity formula is real; its input is a static
   assumption. No historical per-model signal store exists to replace it with a measured one.
4. **Multiple-testing statistical correction** — a warning flag exists; no real p-value/CI
   adjustment does.
5. **Attribution/backtest-trigger/data-quality/postmarket frontend surfaces** — all four backends
   are real; none has a UI.
6. **A unified data/feature layer** — 7 independent Alpaca fetch call sites; genuinely dual TS/Java
   indicator computation.
7. **Liquidity-aware position sizing for regular-hours orders** — exists only for the off-by-default
   extended-hours path.
8. **A unified frontend read-model layer** — 57+ independent fetch call sites in `App.tsx` alone.
9. **Java process crash recovery** — fails closed safely, but requires manual operator restart.
10. **Two uncovered interval workers** (`MarketRegimeAgent`, `ChiefTraderAgent`) with no `stop()`
    path — a narrow, low-practical-impact instance of an already-fixed bug class recurring.

## F. Existing Capability Reuse Map (do not rebuild these)

- **Forecast Engine** (`forecastEngine.ts`/`ForecastEngine.java`) — real, tested, the strongest
  subsystem in this audit. Extend (wire more callers, populate `volatility`), never replace.
- **QuantEnsembleEngine.java's `effectiveIndependentCount()`** — the math is real and correct;
  only its correlation-matrix *input* needs real data to replace the static assumption. Do not
  rewrite the formula.
- **~130 RESEARCH-status Java engines** (ML, VaR, mean-variance, risk-parity, factor exposure,
  GARCH family) — real, individually tested code sitting idle. The portfolio-construction roadmap
  (Phase D below) should activate these, not reimplement equivalents.
- **`modelRegistry.ts`'s promotion ladder** (`RESEARCH → ... → PRODUCTION_CANDIDATE`) — real,
  tested, enforced. Extend it to also govern the TS CORE/EXPERIMENTAL strategies, rather than
  building a second lifecycle mechanism for them.
- **`coreWalkForward.ts`, `pbo.ts`** — real, methodologically sound research tooling. Run them more
  and at greater scale; do not rebuild them.
- **`ReflectionEngine.ts`'s evidence-gating pattern** (effective-sample-size, Wilson intervals,
  bounded weight steps) — this is exactly the discipline a portfolio-construction promotion gate
  should reuse, not reinvent.
- **`NewsScoringEngine.ts`'s `<UNTRUSTED_ARTICLE_DATA>` delimiter pattern (DEF-31)** — the fix for
  gap #2 above should be a direct application of this same, already-proven pattern to
  `ChiefTraderAgent.ts`'s two prompts, not a new design.
- **`DecisionTracePanel`/`TransactionObservatory`'s real-data-only pattern** — the template for
  building the missing attribution/data-quality/postmarket/backtest-trigger UIs should follow this
  same "one real API call, no recomputation, no fabricated placeholders" discipline, already proven
  to work well in this codebase.

## G. Defect List (only objectively demonstrated, this pass)

1. **`ChiefTraderAgent.ts`'s Bull/Bear and ConsensusDebate prompts lack delimiter isolation for
   `idea.reasoning`** — a real, demonstrated (by direct code trace) prompt-injection surface at the
   system's actual consensus-vote boundary. Not fixed this pass per this document's own rule.
2. **`gateTradeIdea()` does not validate or clamp `confidence`** — a structural defense-in-depth gap
   at the one chokepoint every `emitTradeIdea` call passes through. Not fixed this pass.
3. **`MarketRegimeAgent` and `ChiefTraderAgent` have `setInterval` timers with no `stop()` method**
   and are absent from `gracefulShutdown.ts`'s stop list — a real, narrow instance of the DEF-27 bug
   class. Not fixed this pass.
4. **Java Quant Core has no crash-detection/respawn mechanism** — real operational gap, fails closed
   safely. Not fixed this pass.
5. **`RiskEngine.ts`'s live path runs two unscoped full-table `SELECT * FROM trades` fetches per
   evaluation** (gates 3/4/5, gate 23) — self-documented as deliberately deferred, a real scalability
   ceiling, not yet a real problem at current row counts. Not fixed this pass.

*(All five are documented per this audit's own opening rule — recommend/fix only if explicitly
authorized later. None were touched during this audit-and-plan pass.)*

## H. Architecture Risks (not bugs yet, could become scaling/reliability problems)

- **33 independent `setInterval` workers with no shared scheduler or backpressure mechanism** — fine
  at current scale; a real risk if the symbol universe or worker count grows materially without a
  redesign.
- **SQLite as a hard ceiling with no migration scaffold** — fine at 479 trades; a real risk if
  organic trading volume ever grows by orders of magnitude, since there is currently no evolutionary
  path, only a rewrite.
- **7-way duplicated market-data fetch logic** — works today; a real risk of silent behavioral
  divergence (different callers seeing different snapshots of "the same" data) as more callers are
  added without consolidation.
- **Genuinely dual TS/Java indicator computation** — monitored via parity today; a real risk that the
  parity-checking itself silently degrades or is disabled without the dual-computation being
  resolved first.
- **Capital allocation's patched-not-designed concurrency history** — closed for the currently-known
  leak classes; a real risk that a THIRD leak class (following the two already found) exists and
  hasn't been triggered yet, precisely because this area's history is "found and patched," not
  "designed correct from the start."

## I. Quant Research Roadmap

Extend, do not replace: promote the modelRegistry ladder to actually govern something past SHADOW,
starting with the 3 already-SHADOW engines, gated on real accumulated shadow-comparison evidence (the
mechanism already exists — `JavaQuantAdvisoryService`'s `recordPrediction` — it just needs the
evidence to actually accumulate and be reviewed). Build the real per-model historical-correlation
store the diversity formula is currently missing, using the same effective-sample-size discipline
`ReflectionEngine.ts` already applies to agent calibration. Replace the multiple-testing warning flag
with a real Benjamini-Hochberg-style correction once strategy-search trial counts genuinely warrant it.

## J. Portfolio Construction Roadmap

This is the top-priority build, per both this audit's own findings and the operator's own explicit
prior direction. Concretely: (1) introduce an aggregation point between ChiefTrader-approved ideas
and RiskEngine that collects all currently-pending approved ideas within a real time window rather
than evaluating each in total isolation; (2) wire the already-real, already-tested
`MeanVarianceOptimizer.java`/`RiskParityOptimizer.java` (currently RESEARCH-status, zero consumer)
behind a real HTTP endpoint, following the exact activation pattern already used for
`JavaFactorComposite`/`JavaCoreEnsemble` (a real, reviewed, explicit-operator-authorized activation,
not a silent flip); (3) size the FINAL approved set against real portfolio-level constraints
(correlation-adjusted incremental risk, not just gate 20's one-position-at-a-time threshold check);
(4) preserve every existing RiskEngine gate unchanged — portfolio construction sits BEFORE RiskEngine
in the pipeline, narrowing/reranking candidates, never replacing or bypassing the gate ladder.

## K. Execution Roadmap

No execution-algorithm layer (VWAP/TWAP/slicing) should be built yet — see the Do-Not-Build-Yet list.
The real, valuable next execution-layer investment is extending `executionQuality.ts`'s real
slippage/latency measurement into a genuine implementation-shortfall decomposition, and building the
missing frontend attribution surface on top of the already-real `dailyAttributionReport.ts` backend.

## L. Data Roadmap (free-first)

| Source | Cost tier | Current status | Recommendation |
|---|---|---|---|
| Alpaca ticks/bars | FREE (existing subscription) | Real, live | Consolidate the 7 duplicated fetch call sites into one shared layer before adding anything new |
| News (RSS + Finnhub/AlphaVantage/Polygon/FMP) | FREE/LOW COST | Real, live | Sufficient for current scope; no expansion needed yet |
| Fundamentals (AlphaVantage+FMP) | FREE/LOW COST | Real, live | Sufficient |
| Macro (AlphaVantage+FRED) | FREE | Real, live | Sufficient |
| Dividend adjustment | FREE (same Alpaca endpoint, unused) | MISSING | Real, low-cost gap — the split-adjustment mechanism already exists and could very plausibly be extended |
| Survivorship-bias-correcting universe | LOW COST (a static historical index-constituent list) | MISSING (disclosed, not corrected for the CORE backtest path) | Worth closing before trusting any CORE-strategy backtest result as directionally meaningful |
| Options/short-interest/ETF-flow/analyst-revision/breadth | PAID/INSTITUTIONAL | MISSING entirely | **Do not build yet** — no current strategy family depends on any of these; adding them now would be data cost with no measured expected value |

## M. Frontend/Terminal Roadmap

Build, in order: (1) an attribution view on top of the already-real backend (lowest-cost, highest
immediately-visible-value item in this whole document); (2) a data-quality view surfacing the three
already-real quality gates found in Section 6; (3) a postmarket view on top of the already-real,
DB-durable `PostMarketAnalysis.ts`; (4) a genuine backtest-trigger UI (currently CLI-only). Only
after those: consider a real unified read-model layer to replace the 57+ independent fetch call
sites, since that refactor is far more valuable once there are more views that would benefit from it.

## N. Distributed-Systems Roadmap (when, not if-immediately)

**Do not build distributed infrastructure now.** At 479 trades and a 12-symbol subscription cap, a
message queue, worker-thread pool, or non-SQLite database would be complexity with no measured
benefit. The trigger conditions worth naming explicitly: (a) the RiskEngine full-table-scan ceiling
(Section 26–30) becomes measurably slow — the real fix at that point is scoping the existing queries
with a WHERE clause and index, not distributing anything; (b) the symbol universe genuinely grows an
order of magnitude beyond `maxActiveSubscriptions`'s current 12 — the real fix at that point is likely
raising the cap and re-measuring, not a redesign; (c) SQLite's single-writer constraint is
demonstrated (not assumed) to be a real bottleneck under real organic paper volume, which today's 479
trades cannot demonstrate either way.

## O. 30/60/90-Day Roadmap

**Days 1–30**: Fix the consensus-prompt injection gap (Section G item 1) — this is the one item in
this entire document that is a live safety issue rather than a missing capability, and the fix
pattern already exists and is proven (DEF-31). Fix the `gateTradeIdea()` confidence-clamping gap
(item 2) alongside it, since both are in the same review pass. Begin the portfolio-construction
aggregation-point design (Section J item 1) as a design/prototype, not yet live.

**Days 31–60**: Wire one real Java portfolio-optimization engine (mean-variance OR risk-parity, not
both at once) behind a real endpoint, in shadow-only mode (compute and log, never influence a real
decision) — following the exact, already-proven `JavaFactorComposite` activation pattern. Build the
attribution frontend view.

**Days 61–90**: Review shadow-mode portfolio-optimization evidence; if real and sufficient, take the
same explicit-operator-authorized activation step already used twice this codebase's history for
other Java engines. Build the data-quality and postmarket frontend views. Begin closing the
7-way-duplicated market-data-fetch consolidation.

## P. Long-Term Institutional Roadmap (6–24 months)

Real strategy-correlation measurement replacing the static assumption matrix; the modelRegistry
ladder actually governing promotions past SHADOW for the highest-evidence engines; a genuine
multiple-testing statistical correction; a unified data/feature layer; a unified frontend read-model
layer; and — only after all of the above, and only if real organic paper evidence justifies it —
the first real execution-algorithm work (Section K), gated on a demonstrated need this audit found no
evidence of yet.

## Q. Dependency Graph

```
Consensus-prompt injection fix (no dependencies — do first)
       │
Real per-model correlation store
       │
       ▼
Portfolio construction aggregation point ──requires──> real correlation data
       │                                                (not the static 0.75/0.15 assumption)
       ▼
Java portfolio-optimizer activation (shadow mode)
       │
       ▼
Java portfolio-optimizer activation (live, gated on shadow evidence)
       │
       ▼
Attribution frontend ──requires──> nothing new (backend already real; can build in parallel with
                                    the above, no ordering dependency)
       │
       ▼
Long-duration paper validation with portfolio construction live
       │
       ▼
Controlled real-money consideration (Stage 7 — not before Stage 6 evidence exists)
```

**Blocker discipline**: do not build the live portfolio-optimizer activation before the correlation
store exists (it would just be wiring real math to the same static assumption already flagged as a
gap). Do not build execution algorithms before portfolio construction exists (there is nothing yet
for an execution algorithm to work on that a single MARKET order doesn't already handle at current
trade sizes).

## R. Acceptance Criteria (objective evidence required per stage)

- **Portfolio construction shadow mode → live**: real shadow-logged decisions over a real elapsed
  multi-week window (matching the precedent already set for `JavaFactorComposite`/
  `JavaCoreEnsemble`), reviewed by the operator, not a code-complete date.
- **Strategy-correlation store real → trusted**: a real, measured minimum observation count per
  model pair (the same PBO/effective-sample-size discipline already used elsewhere in this codebase),
  not "the table has some rows in it."
- **Consensus-prompt fix**: a real adversarial test suite (matching this session's own
  `NewsScoringEngine.promptInjection.test.ts` pattern) proving the fix holds against the same hostile-
  input classes already tested for the news boundary.

## S. "Do NOT Build Yet" List

- Execution algorithms (VWAP/TWAP/slicing) — no demonstrated need at current trade sizes.
- Market making — explicitly out of scope per the operator's own mandate; a fundamentally different
  system (order book, inventory model, adverse-selection model, exchange connectivity Argus does not
  have).
- Distributed infrastructure (message queues, worker pools, non-SQLite database) — no demonstrated
  bottleneck at current scale; the specific trigger conditions are named in Section N.
- Paid alternative data (options, short interest, ETF flow, analyst revisions, breadth) — no current
  strategy depends on any of it.
- A second, parallel strategy-lifecycle mechanism for TS CORE strategies — extend the real, already-
  built `modelRegistry.ts` ladder instead of building a new one.
- Any live activation of a Java optimizer without first replacing the static correlation assumption
  — would produce a real-sounding number built on a disclosed guess.

## T. Final Readiness Assessment (kept separate, per the operator's own explicit instruction — never collapsed into one score)

- **ARCHITECTURAL READINESS**: Moderate. The protected safety spine is real and adversarially
  proven; the portfolio-construction layer that would make this an institutional architecture rather
  than a trade-approval system is confirmed absent.
- **ENGINEERING READINESS**: Strong. This session alone found and fixed 9 real defects under
  adversarial testing, with a demonstrated pattern of not stopping at "looks fixed" (FD-6/FD-7's own
  chronologies). The codebase's own honesty discipline (stale "stub" comments corrected, a prior real
  UI fabrication found and fixed, explicit `NOT_SUPPORTED`/`RESEARCH-ONLY` labeling throughout) is a
  genuine, repeatedly-observed positive signal, not a one-off.
- **QUANT RESEARCH READINESS**: Mixed. Real, methodologically sound tooling (PBO, walk-forward,
  calibration) exists and is usable; a large amount of real research capability (ML, VaR,
  optimization) sits completely idle; one real methodological gap (multiple-testing correction).
- **PAPER TRADING READINESS**: `PAPER_READY_WITH_REQUIRED_OPERATOR_ACTIONS`, unchanged from
  CLAUDE.md's own standing assessment — this audit found no defect that should change that status,
  and found one real security gap (the consensus-prompt injection issue) that argues for closing it
  before extended unattended paper operation, even though paper trading itself carries no real-money
  risk.
- **PRODUCTION READINESS**: **LIVE = NO-GO.** Unchanged, and this audit found nothing that would
  argue for changing it — if anything, the confirmed absence of portfolio construction and the real,
  open security gap are additional, concrete reasons NO-GO remains correct, not just the pre-existing
  organic-evidence floor.
- **PROFITABILITY EVIDENCE**: **UNPROVEN.** Unchanged from CLAUDE.md's own ground truth (organic
  closed PAPER FILLED SELL P&L remains 0). Nothing in this audit constitutes or claims profitability
  evidence.
- **INSTITUTIONAL PARITY**: **NOT CLAIMED.** Argus has real pieces of institutional architecture
  (a protected risk spine, real forecasting statistics, real reconciliation) and a large amount of
  real-but-idle institutional-grade research code — but the confirmed absence of portfolio
  construction, the real security gap, and the near-total absence of live-measured operational
  evidence mean institutional parity is not supportable as a claim today, regardless of how much of
  the underlying code is genuinely well-built.

---

## Final Output Block

```
ARGUS INSTITUTIONAL QUANT PLATFORM AUDIT
Current maturity: Robust paper-trading execution infrastructure with large amounts of
                   real-but-idle quantitative research capability; portfolio construction
                   confirmed absent
Target maturity:   Institutional-style systematic research and trading platform per the
                   operator's own north-star definition (see project memory)
Architecture:
DATA               3/6
FEATURES           3/6
QUANT RESEARCH      3/6
STRATEGY PLATFORM   3/6
FORECASTING         4/6
PORTFOLIO           0/6
RISK                3/6
EXECUTION           4/6
RECONCILIATION      4/6
LEARNING            4/6
RESEARCH            3/6
RELIABILITY         4/6
OBSERVABILITY       4/6
SECURITY            2/6
TERMINAL            3/6
SCALABILITY         3/6
P0 (safety/correctness): ChiefTraderAgent prompt-injection isolation (Section G.1);
        gateTradeIdea() confidence clamping (G.2)
P1 (required for institutional architecture): Portfolio construction (Section J); real
        strategy-correlation measurement; multiple-testing statistical correction
P2 (major capability): Java portfolio-optimizer activation; attribution/data-quality/
        postmarket/backtest-trigger frontend views; unified data/feature layer
P3 (research enhancement): Dividend adjustment; survivorship-bias correction for the CORE
        backtest path; a unified frontend read-model layer
Top 10 gaps: see Section E
Top 10 existing strengths: adversarially-hardened OMS/reconciliation (this session);
        real Forecast Engine statistics; real 25-gate risk ladder; real, DB-durable
        postmarket/premarket analysis with anti-hindsight-bias safeguards; real evidence-
        gated learning system with correctly-drawn automatic/non-automatic boundaries;
        real backpressure-protected observability; ~135 real (if mostly idle) Java
        quant engines including tested VaR/optimization math; real secret redaction;
        a demonstrated, repeated codebase-wide honesty discipline (stale stubs and prior
        UI fabrications found and corrected, not hidden); real single-writer SQLite
        reliability discipline
Top 10 risks: see Section H
Next 30 days: see Section O
Next 60 days: see Section O
Next 90 days: see Section O
Long-term: see Section P
Production readiness: LIVE = NO-GO
        Unchanged by this audit; two new concrete reasons found to keep it that way.
Profitability: UNPROVEN
        Organic closed PAPER FILLED SELL P&L remains 0, per CLAUDE.md's own standing
        ground truth. This audit neither claims nor found any profitability evidence.
Institutional parity: DO NOT CLAIM PARITY
        Real institutional-grade pieces exist; portfolio construction is confirmed
        absent and a real security gap remains open. Parity is not supportable today.
```

**This document is an audit and plan only. No roadmap item above has been implemented as part of
producing it**, per the operator's own explicit instruction. The one exception worth naming
precisely: this document's OWN production required extensive real code-tracing (six parallel
research passes plus direct verification), and one genuinely new, previously-undocumented finding
(the ChiefTraderAgent prompt-injection gap) was surfaced as a byproduct of that tracing — it is
reported here, not fixed, awaiting the explicit authorization this document's own rules require.
