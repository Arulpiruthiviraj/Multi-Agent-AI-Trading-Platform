# ARGUS — Tomorrow Paper-Trading Final Readiness + Current Architecture Forensic Audit

**Type:** Read-only forensic audit. No source, `.env`, config, database, or trading state was modified to produce this report. Method: direct source reads/greps by three parallel read-only research passes (no Edit/Write tools available to them) + direct `better-sqlite3 {readonly:true}` queries against `data/argus.db` + process/log introspection, continuing directly from `ARGUS_TOMORROW_READINESS_AUDIT.md` (same audit window, ~2026-08-19T03:10 UTC / America/New_York overnight-closed).

**Per the directive's own Part 20 rule:** `ARGUS_CURRENT_ARCHITECTURE.md`, `ARGUS_TOMORROW_PAPER_READINESS.md`, `ARGUS_BLOCKERS.md`, `ARGUS_RUNTIME_TRUTH.md`, `ARGUS_BUY_SELL_FLOW.md`, and `ARGUS_ARCHITECTURE_PROTECTION_AUDIT.md` do not exist yet, so none of them were created. Their proposed contents are folded into the relevant sections below (§1, §16–18, §13/19, §12, §2/§11, §19 respectively), with a pointer summary in §20.

---

## PART 1 — Current architecture map

| Component | File | Purpose | Input | Output | Runtime status | Next stage |
|---|---|---|---|---|---|---|
| Frontend | `src/App.tsx` + `src/components/` | React SPA, 21 tabs | REST + WS | UI | Served via Vite/static | n/a |
| Server entry | `server.ts` | Express + Vite middleware + `ws` | boot | HTTP :3000 | Running (PID 26068) | Bootstrap |
| Bootstrap | `src/server/core/SystemBootstrap.ts` | Wire agents/engines, start workers | env/config | initialized singletons | Runs once at boot | Market data |
| EventBus | `src/server/core/EventBus.ts` | Node `EventEmitter` singleton, applies `gateTradeIdea`/`applyAssetIdeaGate` on every `TRADE_IDEA_GENERATED` (`EventBus.ts:77-98`) | agent emits | routed events | Active | idea agents |
| Market data | `src/server/services/MarketDataWorker.ts` | Alpaca WS ingest, tick validation | Alpaca WS | `MARKET_DATA`/`MARKET_DATA_UPDATED` | Always-on per CLAUDE.md | idea agents |
| Idea agents | Technical/News/Fundamental/Macro/Portfolio/Quant/Kronos | per-agent analysis | ticks/timers | `TRADE_IDEA_GENERATED` | Mixed — see §6 | ChiefTrader |
| Consensus | `src/server/services/ChiefTraderAgent.ts` | debate + weighting | ideas | `CHIEF_APPROVED_IDEA` | Active | RiskAgent |
| Risk | `src/server/engines/RiskEngine.ts` | 24-gate evaluation | approved idea | `RISK_ASSESSMENT_COMPLETED` | Active | OMS |
| Sizing | `src/server/engines/PositionSizing.ts` | share-count math | risk-approved | quantity | Shared BUY/SELL, asymmetric caps (§9/§11) | OMS |
| OMS | `src/server/services/OrderManagement.ts` | sole `.placeOrder(` caller | risk result | broker order | Active | BrokerManager |
| Broker | `src/brokers/BrokerManager.ts` + adapters | order execution | OMS call | fills | Alpaca paper, `Disconnected` in `broker_connections` table (stale/unused metadata row — see §12 caveat) | Portfolio |
| Portfolio/Reconciliation | `src/server/services/PortfolioReconciliation.ts` | sole writer of `portfolio` table (confirmed by grep — no other file inserts/updates it) | broker snapshot | `portfolio`, `reconciliation_events` | Actively cycling (§12) | PortfolioMonitor |
| Exit intelligence | `src/server/services/PortfolioMonitor.ts` + `ExitIntelligenceEngine.ts` | evaluate open positions for exit | live price + bars | `emitRiskExit` → SELL idea | Legacy checks active; new engine OFF (flag) | ChiefTrader (SELL) |
| Opportunity discovery | `src/server/continuous/OpportunityDiscovery.ts` | would-be new-symbol scanner | timer | `WATCHLIST_SUBSCRIBE_REQUESTED` | **NOT WIRED — dead code** (§3) | MarketDataWorker only, never the trade spine |
| Multi-asset overlay | `src/server/multiAsset/*` | equity-tier classification/safety/routing | idea/symbol | pass/block + notional cap | Wired as a gate, not a platform (§5) | EventBus idea gate, RiskEngine cap |
| Observability | `src/server/observability/`, `EventStore.ts`, `observability_events` | structured logs/traces | events | queryable traces | Active (598,593 rows) | n/a |
| AI routing | `src/server/ai/AIRouter.ts` | 6-model routing, failover | agent calls | LLM output | Degraded — recurring `AI_PROVIDERS_EXHAUSTED` (prior audit §3) | agents |
| Config | `src/server/config/*.ts` + `config/*.json` | validated, boot-fails-if-missing loaders | file read | typed config | Active | all |

---

## PART 2 / PART 11 — BUY vs SELL trace and symmetry (source-verified)

**BUY chain**, each arrow classified:

`MARKET_DATA` **VERIFIED** → `TechnicalAgent.analyzeTick()`/timers **VERIFIED** → `TRADE_IDEA_GENERATED` (gated by `gateTradeIdea`/`looksLikeListedTicker`) **VERIFIED** → `ChiefTraderAgent.reviewIdea()` → debate if `confidence > debateTriggerConfidence` **VERIFIED** → `evaluateConsensusSerialized()`, min 2 independent agents, threshold from `tradingSafety.consensusApprovalThreshold` **VERIFIED** → `CHIEF_APPROVED_IDEA` **VERIFIED** → `RiskEngine.evaluateRisk()`, all 24 gates **VERIFIED** → `PositionSizing.ts` multi-cap min (concentration/sector/correlation/notional all apply) **VERIFIED** → `OrderManagement.ts:349-355` sole `placeOrder()` call **VERIFIED** → `BrokerManager` → Alpaca paper **VERIFIED structurally** → fill → `trades`/`fills` **STRUCTURAL ONLY in this database's actual history** — see caveat below.

**SELL (risk-exit) chain**, traced by direct read of current source (`PortfolioMonitor.ts`, `ChiefTraderAgent.ts`, `RiskEngine.ts`, `PositionSizing.ts`, `OrderManagement.ts`):

`PortfolioMonitor.reviewPortfolio()` (~60s tick, real live price via `marketDataWorker.getLatestPrice`, real 400-day bars for thesis/quant checks) **VERIFIED** → branch order: quant strategy target/stop → thesis invalidation → quant-aware trailing stop → generic take-profit → generic trailing/hard-stop → `ExitIntelligenceEngine` (only if none of the above fired *and* `ARGUS_EXIT_INTELLIGENCE_ENABLED=true`, which it currently is **not**, so this branch is dead in production today) **VERIFIED** → `emitRiskExit()` → `eventBus.emitTradeIdea({side:'SELL', agent:'PortfolioManager'})` **VERIFIED, same `TRADE_IDEA_GENERATED` event BUY uses** → `ChiefTraderAgent`'s real event listener (`eventBus.on('TRADE_IDEA_GENERATED', ...)`, not a stub) **VERIFIED** → `isRiskExit(idea)` check → **consensus/debate/min-agents entirely skipped, unconditional approval** (`ChiefTraderAgent.ts:471-478`) **VERIFIED, matches CLAUDE.md's documented design** → `RiskEngine.evaluateRisk()` — still runs, but SELL-side `PositionSizing.ts:180-186` sets `maxQuantity = MAX_SAFE_INTEGER` (concentration/sector/correlation/notional caps do not apply to SELL) → `RiskEngine.ts:558-564` clamps to **exactly** the full held quantity, no partial-quantity path exists in the payload at all **VERIFIED** → same single `OrderManagement.ts:349-355` `placeOrder()` call, `side` just passed through as a string — **no separate BUY/SELL broker code path exists** **VERIFIED** → fill/portfolio/reconciliation shared with BUY **VERIFIED structurally**, again with the same organic-history caveat.

**Symmetry table:**

| Stage | BUY | SELL | Verdict |
|---|---|---|---|
| Discovery | Multi-agent, tick/timer-driven | None — only exit-checks on existing holdings | Asymmetric by design (SELL has no "discovery," it's position-triggered) |
| Agent analysis | Multiple independent agents | Single synthetic agent (`PortfolioManager`) | Asymmetric |
| Consensus | Full debate + min-2-agent threshold | Explicitly skipped, auto-approved | Asymmetric by design (documented in CLAUDE.md) |
| Chief approval | Verified | Verified (same function, auto-approve branch) | Symmetric mechanism |
| Risk gates | All 24 apply | Fewer apply (concentration/sector/correlation skipped) | Asymmetric |
| Sizing | Multi-cap min | Full-held-quantity only, no partial path | Asymmetric — SELL cannot currently do a partial exit through the live spine |
| OMS/Broker/Fill/Portfolio/Reconciliation | Same single code path for both | Same single code path for both | Symmetric — one `placeOrder(` call site total |

**Caveat that applies to every "VERIFIED" mark above involving an actual fill:** the `trades` table contains exactly 4 rows in this database's entire history — 2 `REPLAY` (excluded from organic evidence by CLAUDE.md's own definition) and 2 manually-imported baseline positions (GLD, NVDA) explicitly reasoned as "not an Argus-originated decision." **Zero organic, tick-driven, consensus-approved BUY or SELL has ever completed to a fill in this database.** The pipeline is structurally and mechanically verified end-to-end by direct source reading; it has never been organically exercised end-to-end in practice.

---

## PART 3 — Opportunity discovery (verified NOT WIRED)

`src/server/continuous/OpportunityDiscovery.ts` exists but is **dead code in the current boot path**: `SystemBootstrap.ts` has zero references to `Opportunity`/`continuous`, and the module-level singleton `opportunityDiscoveryWorker` — the only thing that calls `.start()` — is referenced nowhere outside its own definition file except two read-only accessors (`pipelineAgentSnapshot.ts`, `continuousIntelRoutes.ts`) that only read its last-scan status, never start it.

Even if started, it's gated by `ARGUS_OPPORTUNITY_LOOP_ENABLED` (currently `false`), and when enabled its "universe" is a **static 9-symbol seed list** in `config/continuousIntelligence.json` (`AAPL, MSFT, NVDA, AMZN, TSLA, SPY, QQQ, IWM, DIA`), not real dynamic discovery. Its only output is `WATCHLIST_SUBSCRIBE_REQUESTED`, consumed only by `MarketDataWorker` to add a market-data subscription — it never emits `TRADE_IDEA_GENERATED` and has no path into the trade spine at all, even when running.

**Verdict: NOT-WIRED.** "Argus continuously discovers new opportunities across the market" is currently false regardless of flags — the mechanism that would do this isn't started by the process.

---

## PART 4 — Penny stock support (verified STRUCTURAL-ONLY, self-blocked)

`isPennyStockEnabled()` does return `true` given the current `.env`, and real thresholds exist (`pennyMaxPrice: 5`, `pennyMinDollarVolume: 500000`, `pennyMaxSpreadBps: 150`, `pennyMaxAtrPct: 0.15`, per-class notional caps). It reuses the exact same `PositionSizing.ts`/`RiskEngine.ts` path as normal stocks (only the notional ceiling is pre-shrunk before the shared sizing call) — so enabling it cannot broaden behavior for non-penny symbols; the cap logic only ever lowers, never raises, and short-circuits to the global cap when the flag is off.

**But: `config/multiAsset.json` sets `execution.marketOrdersFitPennyAndMicro: false` unconditionally**, and `SafetyFilter.ts` treats that as an automatic `ASSET_MARKET_ORDER_UNFIT` blocking reason for every `PENNY_STOCK`/`MICRO_CAP` candidate — plus both classes have `permittedStrategyIds: []` (zero eligible strategies) in the same config. The result: the flag is "on," the classification and thresholds are real, but the code is self-gated to always fail closed. No OTC/halt/delisting check exists anywhere — `looksLikeListedTicker` is a ticker-format regex, not a listing-status check.

**Verdict: STRUCTURAL-ONLY, currently inert.** Turning the flag on today changes nothing observable — every penny/micro candidate is blocked before it can size an order.

---

## PART 5 — Multi-asset support (verified STRUCTURAL-ONLY / risk overlay, not a platform)

`src/server/multiAsset/` contains only classification/safety/routing/eligibility/research-cost logic (`AssetClassifier.ts`, `SafetyFilter.ts`, `StrategyRouter.ts`, `ideaEligibility.ts`, `OpportunityScanner.ts`, `researchCosts.ts`) — **no discovery worker, no dedicated agent, no OMS routing, no broker adapter, no reconciliation code**. The only "assets" it actually classifies are equity market-cap/price tiers (`LARGE_CAP`…`PENNY_STOCK`, `ETF`, `UNKNOWN`) — there is no crypto/options/futures/forex code anywhere in the directory. The name is aspirational; the implementation is an equity risk-tiering overlay.

That said, the eligibility gate genuinely is wired into the live spine — confirmed by direct grep, not by trusting the architecture-protection test file: `EventBus.ts:77` calls `applyAssetIdeaGate` on every `TRADE_IDEA_GENERATED`, `RiskEngine.ts:540` calls `applySubordinateAssetNotionalCap`. Direct grep for `BrokerManager|OrderManagement|RiskEngine|placeOrder` inside `multiAsset/`/`continuous/` returns only comment lines documenting the absence — the boundary genuinely holds.

| Asset | Discovery | Analysis | Risk | Sizing | OMS | Broker | Exit | Reconciliation | Status |
|---|---|---|---|---|---|---|---|---|---|
| Large/Mid/Small-cap equity | Only via existing agents, not `multiAsset/` | Full | Full 24 gates | Full caps | Shared | Shared | Full | Shared | Real (via the normal spine) |
| ETF | Same as equity | Full | Full | Full | Shared | Shared | Full | Shared | Real |
| Penny/Micro-cap | Would need OpportunityDiscovery (dead) or manual symbol | Full agent path if reached | Full gates + notional pre-cap | Notional pre-capped | Self-blocked before reaching | n/a | n/a | n/a | Structural-only, self-gated inert |
| Crypto/Options/Futures/FX | None | None | None | None | None | None | None | None | Not implemented — enum/naming only, no code |

**Verdict: PARTIAL.** Real for equity sub-tiering; not present at all for any non-equity asset class despite the "multi-asset" name.

---

## PART 6 — Agent pipeline table

| Agent | Enabled (settings) | Running (this boot) | Real data | Last activity (see prior audit §3) | Reaches Consensus | BUY capable | SELL capable |
|---|---|---|---|---|---|---|---|
| TechnicalAgent | true | Yes | Yes, deterministic RSI/MACD/BB | Active through last RTH close (51,014 predictions total) | Yes | Yes | n/a (idea-only, not exit-driven) |
| QuantSignalAgent | true (all experimental flags on) | Ambiguous post-restart (§ prior audit) | Yes when running | 614 `quant_assessments` rows, last pre-restart | Yes | Yes | n/a |
| KronosForecastAgent | true | Yes | Yes, local Chronos | 272 predictions, active through last close | Yes | Yes | n/a |
| FundamentalAgent | true | Yes | Yes, AlphaVantage+AIRouter | ~23h stale at snapshot time (consistent with tracked-symbol/session cadence) | Yes | Yes | n/a |
| MacroAgent | true | Yes | Yes | ~23h stale, same reasoning | Yes | Yes | n/a |
| NewsEngine/NewsAgent | true | Yes | Yes when working | **6 days stale — the one agent with no recent evidence of activity at all** | Unconfirmed recently | Yes | n/a |
| ChiefTraderAgent | n/a (always on) | Yes | n/a | Continuous `ANALYZING`/terminal activity through last close | n/a (is the consumer) | Approves | Approves (auto for risk-exit) |
| PortfolioMonitor / risk-exit (`PortfolioManager`) | Legacy checks always on | Yes (~60s timer) | Yes, live price + bars | Not directly observed firing in this snapshot window | Yes (auto-approved) | n/a | Yes, full exits only |
| ExitIntelligenceEngine | `ARGUS_EXIT_INTELLIGENCE_ENABLED=false` | **No — dead branch in production today** | n/a while off | n/a | n/a | n/a | Would be PARTIAL/TRAIL/full, but PARTIAL/TRAIL are telemetry-only even when on |

---

## PART 7 — Consensus mechanics + Incident A resolution

Mechanics (source-confirmed): `CONSENSUS_APPROVAL_THRESHOLD = tradingSafety.consensusApprovalThreshold`; `MIN_INDEPENDENT_AGREEING_AGENTS = tradingSafety.minIndependentAgreeingAgents`; debate triggers when `adversarialDebateMode && confidence > tradingSafety.debateTriggerConfidence`; `debateCooling` uses `tradingSafety.consensusDebateCooldownMs`; per-symbol serialization exists (`debatePending`/queue) to prevent two concurrent evaluations racing on `recentIdeas` (this is the exact race this session's earlier defect-audit already found and fixed — `recentIdeas = recentIdeas.filter(i => !relevantIdeas.includes(i))`, confirmed still in place). Risk-exit SELLs bypass all of this via `isRiskExit(idea)`.

**Incident A — idea-generation storm — VERDICT: FIX FOUND AND LOOKS SUFFICIENT.**

Root cause confirmed directly in source history: `TechnicalAgent.analyzeTick()` called `checkStrategies()` (which fires `TRADE_IDEA_GENERATED` → full ChiefTrader debate → real AI calls) on *every tick* once the rolling price-history buffer reached `technicalHistoryBars` — no per-symbol cooldown existed at all prior to the fix, so a fast tick stream on SPY/QQQ/IWM/DIA could genuinely produce hundreds of ideas and thousands of AI calls per minute exactly as the kill-switch log describes.

The fix is real and present: a `lastEvaluatedAt` map plus `if (now - last < quantThresholds.technicalEvaluationCooldownMs) return;`, with `technicalEvaluationCooldownMs: 30000` in `config/quantThresholds.json` — a genuine 30-second per-symbol throttle — backed by a new regression test (`TechnicalAgent.gate.test.ts`). Commit `00816d8`, authored `2026-08-18T19:34:47Z`, is 5 minutes after the recorded pause and self-documents the exact symptom (SPY/QQQ/IWM/DIA, 543 ideas/60s, 15,183 AI calls/60s) almost verbatim against the kill-switch reason text — this is a real, dated, tested fix, not just a log claim.

**Caveat, not covered by this fix:** no equivalent per-symbol throttle was found in `QuantSignalAgent` or `KronosForecastAgent`. Nothing in the incident evidence implicates them specifically, but their idea-generation rate under sustained fast ticks is unverified by this audit — worth a targeted look before assuming the whole agent layer is storm-proof, not just `TechnicalAgent`.

---

## PART 8 — RiskEngine 24 gates

Full gate table and fail-closed rules are already exhaustively documented in `CLAUDE.md` §2 (gates 1–24, `config/riskGateOrder.json` catalog order) — not re-derived here to avoid duplicating ground truth. Relevant addition from this audit: penny/micro-cap symbols receive **no additional risk gates** beyond the standard 24 — the only penny-specific control is the pre-emptive notional cap shrink in `RiskEngine.ts:540` before the shared `calculatePositionSizing()` call, and the unconditional `SafetyFilter.ts` block described in §4. There is no risk-gate path that could "accidentally prevent all trades" beyond what's already documented (e.g. `duplicate_signal`/`emergency_stop` dominating recent rejections, which is expected fail-closed behavior per the prior audit's DB sample of 211/216 rejected).

---

## PART 9 — Position sizing

`FIXED_DOLLAR` (`maxTradeSize`, default `$3,000`) is the live default; `PERCENT_OF_EQUITY` is opt-in. A candidate can pass every agent and every risk gate and still produce a zero-share `CLAMPED` result — CLAUDE.md already documents this is treated as a hard FAIL, never a silent pass. SELL-side sizing (§2/§11) has no partial-quantity path at all — it is binary: full held quantity or nothing, gated only by `sell_position_exists`.

---

## PART 10 — Existing-position intelligence (full trace, source-verified)

Covered in full in §2/§11's SELL chain above. Summary: this is a **real, source-verified autonomous loop**, not just code that exists — `PortfolioMonitor` runs on a live timer, pulls real live price and real historical bars, walks a real ordered set of exit checks, and a triggered exit genuinely reaches `ChiefTrader → RiskEngine → OMS → BrokerManager` through the identical code path a BUY uses, with consensus and the wider risk-gate set intentionally skipped by design for this one synthetic agent. The one soft spot: `ExitIntelligenceEngine`'s more nuanced `PARTIAL_TAKE_PROFIT`/`TRAIL` decisions are recorded as telemetry only and never reach the order path, and the engine itself is currently flag-disabled, so today only the legacy take-profit/trailing-stop/thesis-invalidation checks are live.

---

## PART 12 — Current runtime (restated from prior audit, still current)

PID 26068, boot `2026-08-19T03:05:16Z`, loaded the current `.env` (all experimental quant/multi-asset/penny flags on). `trading_state=TRADING_ENABLED`, `auto_bot_enabled=1`. Reconciliation actively cycling in real time. Full detail in `ARGUS_TOMORROW_READINESS_AUDIT.md` §1, not repeated here.

**One correction from this pass:** the `broker_connections` table shows Alpaca `status: 'Disconnected'` with null encrypted credentials — this table is very likely a stale/unused UI-metadata row, not the authoritative connection state (the process is verifiably talking to Alpaca live, per the fresh `portfolio_snapshots.current_price` data and active reconciliation), but this audit could not fully reconcile that discrepancy from the database alone — flagged as an open question, not resolved.

---

## PART 13 — Database forensics (restated, see prior audit §3–4 for full tables)

Zero organic fills ever (4 `trades` rows total: 2 REPLAY, 2 manually-imported baseline). 0/97 consensus approvals in the last 24h (fail-closed at the 75% threshold, expected). 211/216 risk assessments rejected historically (`duplicate_signal`/`emergency_stop` dominant). No opportunity/candidate table exists in the schema — consistent with §3's finding that discovery never reaches a persisted-candidate stage.

---

## PART 14 — Incident forensics (final)

**Incident A** (idea storm): resolved above, §7 — fix found, dated, tested, sufficient for the specific agent implicated.

**Incident B** (recurring ~$403 reconciliation mismatch) — **VERDICT: root cause identified, and it is NOT what the manually-imported-position theory suggested.**

`PortfolioReconciliation.ts` is confirmed the sole writer of the `portfolio` table. When broker/local quantities match within tolerance, differing `averagePrice` is silently overwritten, never flagged as a mismatch — so a stale imported cost basis cannot itself be the trigger. The real mechanism, confirmed against live `reconciliation_events` rows 146 (`$403.94`) and 299 (`$403.20`): both are `type: "MISSING_LOCALLY"` for GLD (`localQty:0` vs `remoteQty:1`) — i.e. GLD's own market value (~$400) is the "~$403" figure, not a cost-basis delta. `portfolioReconcileCompare.ts` self-documents the actual cause in its own comments: an intermittent drizzle transaction-visibility race where `loadLocalHoldings()` can return an empty/short read. Since GLD and NVDA are literally the only two positions in the account, any such race necessarily surfaces as "GLD/NVDA MISSING_LOCALLY." A retry-on-empty-read mitigation exists (`PortfolioReconciliation.ts:131-136`), but the underlying race is mitigated, not eliminated — `PAUSE_CONSECUTIVE_CYCLES=2` explains why 3 consecutive bad cycles (events 144→146) crossed the pause threshold while a later single-cycle blip (event 300) didn't.

**This is a real, not-fully-fixed defect**: a third pause from the same root cause remains plausible, and it will recur as "GLD/NVDA mismatch" specifically because those are the only two current holdings — not because of anything special about how they were imported.

**Incident C** (10-second EMERGENCY_STOP cycle, 02:07:39→02:07:49): not independently resolvable from source — no automation, cron, or test-harness call to `/api/v1/system/emergency-stop` was found by any of the three research passes (none were tasked to look for it directly this round; the prior audit already searched `kill_switch_events` for an actor/reason and found only "Manually triggered" / "reviewed... and resumed," both attributed to `admin`). Remains **unresolved** — most consistent with a manual smoke-test of the kill switch given the 10-second gap, but this is inference, not evidence, and should be confirmed with the operator directly rather than assumed.

---

## PART 15 — Tomorrow-morning simulation

09:30 ET: ticks arrive → TechnicalAgent fires ideas at most once per 30s per symbol (fix in place) → ChiefTrader debates/approves per the normal threshold → RiskEngine's 24 gates run → OMS/Alpaca paper places whole-share MARKET orders → fills would flow back to `trades`/`fills`/`portfolio` → reconciliation keeps its ~5-min cycle, with a real, not-fully-eliminated chance of a MISSING_LOCALLY false-mismatch on GLD/NVDA recurring and re-pausing trading. In parallel, `PortfolioMonitor` keeps evaluating GLD/NVDA every ~60s for exit; a genuine TAKE_PROFIT/EXIT/EMERGENCY_EXIT would reach the broker exactly like a BUY. No new symbol enters the universe at any point — `OpportunityDiscovery` is dead code, so "tomorrow" only ever analyzes whatever agents/timers already cover (index ETFs, tracked Fundamental/Macro symbols, and the two existing holdings).

**"Can Argus discover a new stock, analyze it, approve it, buy it, receive a fill, and then continuously monitor it for an eventual automatic SELL?"**

**PARTIALLY.** The analyze→approve→buy→fill→monitor→sell chain is real and mechanically verified end-to-end (once a symbol is in scope). The "discover a new stock" step is not — there is no running mechanism that expands the traded universe beyond what's already hardcoded/subscribed. A genuinely new, previously-untracked symbol will not enter this pipeline tomorrow no matter what happens in the market.

---

## PART 16 — Paper readiness scoring

Methodology: GREEN = source-verified real behavior with recent DB evidence of activity; YELLOW = structurally present but unverified, stale, or self-limited; RED = confirmed not working / dead / self-blocked; UNKNOWN = could not be determined from available read-only evidence. No composite formula is invented — percentages below are a plain count of GREEN vs total scored items, stated as a rough proportion, not a certified score.

| # | Item | Score |
|---|---|---|
| 1 | Boot reliability | YELLOW (boots, but a crash-cascade preceded this boot with cause unconfirmed) |
| 2 | Market data | GREEN |
| 3 | Opportunity discovery | RED (dead code) |
| 4 | Penny stock discovery | RED (self-blocked) |
| 5 | Multi-asset discovery | YELLOW (equity-tiering only, no other asset classes) |
| 6 | Technical analysis | GREEN |
| 7 | Quant | YELLOW (activity unconfirmed post-restart) |
| 8 | Kronos | GREEN |
| 9 | Fundamental | YELLOW (stale, plausibly session-gated) |
| 10 | Macro | YELLOW (same) |
| 11 | News | RED (6 days stale) |
| 12 | Consensus | GREEN |
| 13 | ChiefTrader | GREEN |
| 14 | Risk | GREEN |
| 15 | Position sizing | GREEN (BUY); YELLOW (SELL, no partial path) |
| 16 | OMS | GREEN (structurally); YELLOW (zero organic completions ever) |
| 17 | Alpaca paper | YELLOW (`broker_connections` row inconsistent with observed live activity — unresolved) |
| 18 | Fill handling | YELLOW (never exercised organically) |
| 19 | Portfolio | GREEN |
| 20 | Reconciliation | YELLOW (real race, mitigated not fixed) |
| 21 | Existing-position monitoring | GREEN |
| 22 | Automatic exits | GREEN (full exits); RED (partial exits, telemetry-only) |
| 23 | Rate limiting | GREEN (TechnicalAgent, fixed+tested); YELLOW (Quant/Kronos unconfirmed) |
| 24 | Backpressure | YELLOW (only confirmed at OpportunityDiscovery, which is itself dead) |
| 25 | AI reliability | RED (recurring `AI_PROVIDERS_EXHAUSTED`) |
| 26 | Observability | GREEN |
| 27 | Database integrity | GREEN |
| 28 | Recovery | YELLOW (crash.log not located/read) |
| 29 | Kill switch | GREEN (works); YELLOW (one unexplained 10s cycle) |
| 30 | Testing | GREEN (1,475 tests passing per last snapshot) |
| 31 | Security | YELLOW (no CODEOWNERS/hooks; CI runs tests but branch-protection enforcement unverifiable from filesystem) |
| 32 | Configuration safety | RED (`.env` currently contradicts CLAUDE.md's own "don't enable flags to see if it works" guidance) |

Rough tally: 13 GREEN, 14 YELLOW, 5 RED (mixed items counted once at their dominant color) out of 32 → **mechanically runnable: high; supervised paper readiness: moderate; unattended paper readiness: low; live readiness: not applicable (hard NO-GO regardless of score).**

---

## PART 17 — GO / NO-GO

**SUPERVISED PAPER TOMORROW: CONDITIONAL GO.** Evidence: TechnicalAgent's storm-fix is real, dated, and tested; the core BUY/SELL spine is mechanically sound end-to-end; PAPER/LIVE isolation is intact. Condition: an operator must be watching reconciliation (MISSING_LOCALLY race unresolved) and AI-provider health (recurring exhaustion) in real time, not merely have the process running.

**UNATTENDED PAPER: NO-GO.** Evidence: the reconciliation race can recur and re-pause trading with no auto-resume by design (correct fail-closed behavior, but it means unattended operation will silently stall); `OpportunityDiscovery` being dead is actually protective here (nothing scans wildly unattended) but also means unattended operation isn't "autonomous trading," it's "autonomous monitoring of two fixed holdings plus whatever a static agent set already covers"; NewsAgent staleness and AI-provider exhaustion are unmonitored without a human present.

**LIVE MONEY: NO-GO.** Unconditional, per CLAUDE.md ground truth (6/28→likely 5/28 mandatory gates, `tradingEdgeScore: 8/100`, zero organic paper evidence). Nothing in this audit changes that; several findings here (dead discovery, self-blocked penny stocks, unresolved reconciliation race) make the case stronger, not weaker.

---

## PART 18 — Tomorrow operator checklist

- [ ] Confirm process boot clean; check for `data/logs/crash.log` (not read in this audit — do this first)
- [ ] Confirm `PAPER_TRADING_ONLY=true` in the `.env` actually loaded (verify via a loaded-config endpoint if auth is available, not just the file)
- [ ] Note: `.env` currently has all experimental quant/multi-asset/penny flags on — decide deliberately whether that's intended for tomorrow's session or should be reverted to CORE-only before market open
- [ ] Confirm broker connectivity through live reconciliation activity, not the `broker_connections` table (that row reads `Disconnected` and appears stale/unreliable)
- [ ] Watch for a 3rd GLD/NVDA `MISSING_LOCALLY` reconciliation pause — known unresolved race, not a new problem if it recurs
- [ ] Watch AI-provider health — recurring `AI_PROVIDERS_EXHAUSTED` in observability_events; confirm Ollama-routed agents specifically are still healthy since the cloud fallback chain is largely offline
- [ ] Spot-check NewsAgent produces a fresh prediction early in the session (6-day-stale at last check)
- [ ] Thresholds already enforced in code, use these (not proposals): `technicalEvaluationCooldownMs: 30000` (`config/quantThresholds.json`), `reconPauseConsecutiveMismatchCycles: 2` (`config/tradingSafety.json`), `maxOrdersPerMinute: 5` (settings), `stalePriceThresholdMs: 300000`
- [ ] **Proposed, not existing** (recommendation only): a per-symbol idea-rate ceiling for QuantSignalAgent/KronosForecastAgent analogous to TechnicalAgent's fix, since neither was confirmed to have one
- [ ] Confirm kill switch is in the expected state before market open — check the latest `kill_switch_events` row, don't assume from memory

---

## PART 19 — Architecture protection audit

`architecture.protection.test.ts` (already read in full this session) genuinely enforces: BrokerManager import allowlist, extension-zone (`multiAsset/`, `continuous/`) never importing OrderManagement/RiskEngine/BrokerManager or calling `.placeOrder(`, a single authorized-emitter allowlist for `CHIEF_APPROVED_IDEA`, and `trading_state` writable only from `TradingEngine.ts`. This audit's own independent greps (not trusting the test file) corroborate the boundary holds today for `multiAsset/`/`continuous/`.

**Gaps found this pass:** no `CODEOWNERS` file exists; no local git hooks (no husky/pre-commit) enforce anything. `.github/workflows/ci.yml` does run `npm test` (which includes the architecture-protection suite) on every push to `main` and every PR — so CI *would* catch a violation — but whether GitHub branch protection actually requires that check to pass before merge is a repository setting, not verifiable from the local filesystem. **An AI coding agent working locally without pushing to CI would not be blocked in real time from attempting a spine violation** — the safety net is real but async (catches it on push/PR, not on save), and its enforcement depends on a GitHub setting this audit cannot see.

---

## PART 20 — Proposed contents pointer (files intentionally not created)

Per the directive's own rule, the following were not created as separate files since they don't already exist; their content lives in the sections noted:

- **ARGUS_CURRENT_ARCHITECTURE.md** → §1
- **ARGUS_TOMORROW_PAPER_READINESS.md** → §15–18
- **ARGUS_BLOCKERS.md** → Top-10 blockers list, final summary below
- **ARGUS_RUNTIME_TRUTH.md** → §12 (and `ARGUS_TOMORROW_READINESS_AUDIT.md` §1 for full detail)
- **ARGUS_BUY_SELL_FLOW.md** → §2/§11
- **ARGUS_ARCHITECTURE_PROTECTION_AUDIT.md** → §19

---

# FINAL EXECUTIVE SUMMARY

## CURRENT ARCHITECTURE
Single-process Node/Express+Vite app. The protected spine (idea agents → ChiefTrader → RiskEngine → OMS → BrokerManager) is real, source-verified, and boundary-enforced by tests + CI. Around it sit two "extension zone" additions — `continuous/OpportunityDiscovery.ts` (never started) and `multiAsset/*` (a genuine but narrow equity risk-tiering overlay, wired into the spine only as a gate, never as a discovery or execution path).

## NEW STOCK DISCOVERY
**NO.** Evidence: `OpportunityDiscovery.ts`'s `.start()` is called nowhere in `SystemBootstrap.ts` or anywhere else in the repo outside its own file; even when manually enabled it only scans a static 9-symbol seed list and never emits a trade idea.

## PENNY STOCKS
**NO** (structurally present, functionally inert). Evidence: `config/multiAsset.json`'s `marketOrdersFitPennyAndMicro: false` makes `SafetyFilter.ts` block every penny/micro-cap candidate unconditionally, and `permittedStrategyIds: []` leaves zero eligible strategies for that class regardless.

## MULTI-ASSET
**PARTIAL.** Evidence: real, wired equity-tier classification/risk overlay (`EventBus.ts:77`, `RiskEngine.ts:540`); zero code for crypto/options/futures/FX despite the name.

## EXISTING POSITION MONITORING
**YES.** Evidence: `PortfolioMonitor.reviewPortfolio()` runs on a live ~60s timer with real price/bar data and a real ordered exit-check chain confirmed by direct source read.

## AUTOMATIC SELL
**YES for full exits (TAKE_PROFIT/EXIT/EMERGENCY_EXIT)**, **NO for partial exits.** Evidence: `emitRiskExit()` reaches the identical OMS/broker call path as BUY, consensus-skipped by design; `PARTIAL_TAKE_PROFIT`/`TRAIL` decisions are recorded via `recordPortfolioDecision` only and never trigger `emitRiskExit` (`PortfolioMonitor.ts` exit-decision gate, confirmed unchanged).

## END-TO-END BUY
**STRUCTURALLY VERIFIED, ORGANICALLY UNPROVEN.** Evidence: every stage traces to real code with a single authorized call site at each junction, but the `trades` table has zero organic (non-REPLAY, non-imported) fills in its entire history.

## END-TO-END SELL
**STRUCTURALLY VERIFIED, ORGANICALLY UNPROVEN.** Same evidence basis as BUY — mechanism confirmed real, never yet organically exercised to completion.

## TOMORROW SUPERVISED PAPER
**CONDITIONAL GO.**

## UNATTENDED PAPER
**NO-GO.**

## LIVE
**NO-GO.**

## TOP 10 BLOCKERS
1. Recurring, unresolved reconciliation transaction-visibility race (GLD/NVDA `MISSING_LOCALLY`, ~$403 twice in 2 days) — mitigated, not fixed.
2. `OpportunityDiscovery` is dead code — no new-symbol discovery exists in the running process at all.
3. Penny-stock support is self-blocked by its own config (`marketOrdersFitPennyAndMicro: false`) — enabling the flag changes nothing.
4. `.env` currently contradicts CLAUDE.md's own "don't enable flags to see if it works" guidance (all experimental quant + multi-asset + penny on).
5. Zero organic BUY or SELL has ever completed in this database — the entire live path is unproven in practice, only in source.
6. NewsAgent has produced nothing in 6 days with no confirmed cause.
7. AI-provider chain shows recurring `AI_PROVIDERS_EXHAUSTED` errors; cloud fallback largely offline.
8. QuantSignalAgent/KronosForecastAgent have no confirmed per-symbol idea-rate throttle analogous to TechnicalAgent's fix.
9. Unexplained 10-second EMERGENCY_STOP cycle with no real investigative trail.
10. Architecture protection depends on CI + an unverifiable GitHub branch-protection setting — no CODEOWNERS or local hook backstops it in real time.

## TOP 10 THINGS THAT ARE ACTUALLY WORKING
1. The core BUY spine (agents → consensus → risk → sizing → OMS → broker) is genuinely wired, single-call-site, and boundary-tested.
2. The SELL/exit spine reaches the identical OMS/broker path as BUY — not a separate, weaker mechanism.
3. TechnicalAgent's idea-storm fix is real, dated, config-driven, and covered by a new regression test.
4. RiskEngine's 24-gate ladder is fully evaluated and recorded every time, fail-closed.
5. Reconciliation is actively cycling in near-real-time against the live broker.
6. PAPER/LIVE isolation (`PAPER_TRADING_ONLY`) is intact and unconditional.
7. Multi-asset equity risk-tiering gate is genuinely wired into both the idea gate and RiskEngine, not orphaned.
8. Architecture-protection tests correctly hold the extension zone (`multiAsset/`, `continuous/`) to no direct spine access, independently re-confirmed by grep.
9. CI runs the full test suite (1,475 tests passing at last snapshot) including architecture protection on every push/PR.
10. Kill-switch mechanism itself functions correctly and consistently across every observed transition.

## MOST IMPORTANT ANSWER

Argus cannot currently scan the market for new profitable opportunities — the component built to do that is not started by the running process — and its penny-stock support, while flagged on, is unconditionally self-blocked before an order can size, so neither "continuous discovery" nor "penny stocks" describes anything the system does today; what it does do, and does with real, source-verified, test-covered mechanics, is analyze a small fixed set of symbols and its two existing holdings through independent agents and consensus, route approved BUYs and — separately, with consensus intentionally skipped — approved full-exit SELLs through the identical risk-gated order path to the broker, and continuously reconcile the result, but every stage of that path has so far only ever fired on REPLAY data or manually-imported positions, never on an organic, live-tick-driven decision, so the honest answer is that the machinery for autonomous buy-then-monitor-then-sell is real and connected end-to-end, while both "find new things to buy" and "prove it works on a real decision" remain open.
