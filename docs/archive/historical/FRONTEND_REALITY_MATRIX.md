# FRONTEND_REALITY_MATRIX.md

**Hardening pass, Phase 11.** A fresh, from-scratch re-scan of all 20 frontend tabs against the *current* backend (including everything changed in Phases 1-10 of this hardening pass), produced via three parallel research passes covering tabs 1-7, 8-14, and 15-20, each independently verifying every widget's claimed backend call against the real route file and the real DB table/computation behind it — no widget's status was taken on trust from a comment or a prior document. This document is read-only research; **no code was changed to produce it**, per Phase 11's own scope ("do not implement fabricated areas merely for visual completeness — honest 'Not Implemented' preferred").

This supersedes the tab-by-tab tallies in `CURRENT_STATE_BASELINE.md` §4 and `FINAL_APPLICATION_STATE_ANALYSIS.md`'s Frontend/UI Analysis section, both of which explicitly flagged themselves as not re-verified after this session's mid-stream widget fixes. Several of *their* claims are now stale in both directions — some widgets they called fake are now real; a few they called real are now confirmed broken. Both directions are called out explicitly below.

## Legend

- **REAL** — genuinely backed by a real backend call that queries a real DB table or performs a real computation.
- **PARTIAL** — real backing exists but with a material caveat (partially fabricated, stale, or a real route that doesn't return what the UI expects).
- **MOCKED** — a hardcoded array, `Math.random()`/`Date.now() % X` fake-RNG, a `setTimeout`-only fake computation, or invented data, rendered as if real.
- **NOT_IMPLEMENTED** — an honest empty/placeholder/"Not yet implemented" state. This is a *good* outcome under this project's own UI Truth Principle, not a defect.
- **BROKEN** *(added in this pass — not one of the four requested categories, kept because several findings are strictly worse than "shows fake data" and deserve to be visually distinct)* — the UI calls a backend route that does not exist (will 404), or reads a response field the real route never returns (permanently stuck at a default/zero value). Both are functional bugs, not merely honesty violations.

---

## Full tab-by-tab matrix

### `dashboard` — Autonomous Dashboard

| Widget | Verdict | Evidence |
|---|---|---|
| Top banner, Hands-Off toggle | MOCKED | `AutonomousDashboard.tsx:69-92` — static badge, local state only |
| Portfolio Value `$103.45` / Today's P/L `+$3.45` | MOCKED | `AutonomousDashboard.tsx:110,114` — literal hardcoded strings |
| Intraday Performance chart | BROKEN | `AutonomousDashboard.tsx:51-52` fetches real `GET /api/v1/pnl/analytics` (`systemRoutes.ts:225-258`), but reads `data.curve` — the real route returns `{history:[...]}`. Chart is always empty despite a real backend call succeeding. |
| "What is the AI doing?" activity feed | MOCKED | `AutonomousDashboard.tsx:158-179` — 5 hardcoded always-pulsing bullets |
| AI System Health block | MOCKED | `AutonomousDashboard.tsx:183-214` — hardcoded "Healthy"/"Available"; provider list doesn't match real `AIRouter` providers |
| Safety Controls Overview | PARTIAL | `AutonomousDashboard.tsx:225-241` — Daily Loss is real (`autoBotConfig.dailyLossLimit`); Max Trade/Positions/Emergency Stop are hardcoded |
| Daily AI Trading Report | MOCKED | `AutonomousDashboard.tsx:257-314` — fully fabricated, no state/fetch at all |

### `command` — Mission Control

| Widget | Verdict | Evidence |
|---|---|---|
| Master Control (Emergency Stop/Start, mode select) | REAL | `App.tsx:8225-8267` → `POST /api/v1/system/emergency-stop`/`/resume`, `/api/v1/autobot/toggle` |
| Granular Module Toggles | MOCKED | `App.tsx:8296-8381` — `handleToggle`/`handleSetMode` mutate local `useState` only; zero backend call. **Confirmed still fake** — this is the item flagged HIGH RISK earlier this engagement, Change Plan presented, never implemented, and this re-scan confirms nothing has changed. |
| Allocated Budget / Available-to-Trade readout | REAL | `App.tsx:8450-8472` — real `portfolioData.buying_power`, ties to the real Phase-earlier `TradingEngine.toggle()` budget gate |
| Live LLM "Thought Stream" Console | REAL | Fed by real WS `AUTOBOT_STATE_UPDATED` → real `TradingEngine.state.history` |
| GuardrailsPanel (11 toggles) | MOCKED | `GuardrailsPanel.tsx:41-57` — local `useState`, no fetch anywhere |
| RiskExposureDashboard (VaR gauge, sector pie) | MOCKED | `App.tsx:542-663` — hardcoded 5-entry sector array; `portfolioVaR = dailyLossCap * 0.68` is an invented formula, not a real VaR calculation |
| LiveBotTelemetryPanel — CPU/Mem/Latency | REAL | Real WS `SYSTEM_METRICS` from `SystemMetricsWorker.ts` |
| LiveBotTelemetryPanel — Est. Executions | MOCKED | Fabricated formula (`spent/maxTradeSize*1.5`), not a real count |
| LiveBotTelemetryPanel — Win Rate / Total PNL | BROKEN | Reads `d.summary.winRate`/`d.summary.totalProfitLoss` from `/api/v1/pnl/analytics`; the route never returns a `summary` key. Permanently stuck at 0. |
| LiveBotTelemetryPanel — Network Streams % | MOCKED | Fixed `88%`/`0%` |
| ShadowPortfolioBenchmark | REAL | `server.ts:1772-1836` — real parallel shadow-portfolio equity vs real active-broker equity; real veto ledger from real `RISK_ASSESSMENT_COMPLETED` rejections |
| Dual LLM Trade Verification Engine | REAL | `POST /api/v1/llm/dual-verify-trade`, real `AIRouter` calls |
| AutonomousMissionControl "Strategy Arena" | MOCKED | 4 hardcoded strategy cards, fixed `winRate:68` on "Generate Strategy" |

### `observatory`

| Widget | Verdict | Evidence |
|---|---|---|
| Transaction Explorer (search/filter/replay) | REAL | `TransactionExplorer.tsx` → `GET /api/v2/transactions` |

### `arena` — Trading Arena

| Widget | Verdict | Evidence |
|---|---|---|
| Win/Loss Ratio, Win Rate %, Net Valuation P&L cards | REAL | Computed from real `trades` table via `GET /api/v1/trades` |
| Asset Trade Summary table | REAL (core) / PARTIAL | Symbol/PnL/win-rate real; "Agent Node"/"Trend" columns honestly show `N/A`/`—` now (the old fabricated dominant-agent tooltip was removed, correctly not replaced with a new fabrication) |
| Strategy Synergy Matrix | REAL | `GET /api/v2/strategy/agent-synergy` — real Pearson correlation over `agent_predictions` |
| Order Book (L2) Depth Heatmap | NOT_IMPLEMENTED | Honest "L2 Depth Data Unavailable" state (permanent, documented in `CLAUDE.md` — no L2 data source exists) |
| Market Sentiment Trend | REAL | `GET /api/v2/market/sentiment-trend` — real `news_articles` sentiment average |
| Risk Attribution Treemap | REAL | `GET /api/v2/portfolio/risk-attribution` — real `portfolio` table + GICS sector map |
| Strategy Profit Sunburst | REAL | `GET /api/v2/portfolio/pnl-by-symbol` — real `trades.profitLoss` |
| Trade Efficiency Report | REAL | `GET /api/v2/agents/efficiency` — real `agent_performance_stats`/`agent_predictions.latencyMs` |
| Execution Quality Chart | REAL | `GET /api/v2/trading/execution-quality` — real submit-to-fill latency (slippage deliberately omitted, no real number exists for it) |
| Risk Decomposition & Attribution (stacked area, weight sliders) | MOCKED | `App.tsx:4900`, `mockRiskDecompositionData` — `Math.sin`/`cos`-seeded 30-day array. **Confirmed still fake** — explicitly deferred earlier this engagement, unchanged. |
| Advanced Trade Sandbox / Execute Override | REAL, but incomplete | `POST /api/v2/trading/execute-override` — real RiskEngine gate ladder + real broker fill. **This session added a real `cancel-order` backend route (`POST /api/v2/trading/cancel-order/:id`, Phase 2) but no UI in this panel calls it** — confirmed via repo-wide search of `App.tsx` for `cancel-order`/`cancelOrder`. The sandbox only ever displays terminal outcomes; there is no way for a user to cancel a still-open order from this UI. |
| Market Historian Agent (Event Memory Search) | NOT_IMPLEMENTED | Honest "no real historical-event-matching infrastructure exists" state |
| Dynamic Sparkline/SMA/RSI/MACD overlay (Price Alerts card) | MOCKED | 40-bar series is `charCodeAt()`+sine/cosine-seeded; only the final point is a real live price. Real indicator math computed on fabricated input. |
| Asset Price Alerts (triggers/toasts) | PARTIAL | Real trigger logic, built on the fabricated 40-bar series above; the panel's own copy admits "live simulated prices" |
| Live Broker Feed — trade list | REAL | Real `trades` state |
| Live Broker Feed — broker-selector dropdown | MOCKED | **Only half-fixed from the prior "fake broker dropdown" finding.** `App.tsx:5748-5762` offers `Robinhood (Mock/Live)` and `Charles Schwab (Live)` — **no adapter exists for either anywhere in this codebase** (real registered brokers: `internal_paper`, `alpaca`, `questrade`, `ibkr`, `coinbase`). Purely cosmetic client state; never reaches `BrokerManager`. The *Settings tab's* `BrokerManagement.tsx` (below) already fixed this exact anti-pattern — this Arena-tab widget did not inherit that fix. |
| Risk Veto Audit Trail | NOT_IMPLEMENTED (effectively dead) | `GET /api/v1/risk` serves `riskVetos`, an array **never pushed to anywhere** in the codebase — always renders its honest empty state, but for the wrong reason (dead writer, not "no vetoes occurred yet") |
| Swarm Decision Outcomes ("Run Analysis") | BROKEN (regressed from real) | Backed by `/api/v1/signals`, which is **now a static deprecation stub** (`server.ts:1204-1220`) returning `{decision:"HOLD", confidence:0.5, compiled_signals:[]}` unconditionally, regardless of input. `FINAL_ANALYSIS.md` rated this real; it no longer is, as of whenever that endpoint was deprecated. |

### `scanner` — Strategy Scanner

| Widget | Verdict | Evidence |
|---|---|---|
| Global Strategy Scanner (RSI table) | REAL | `GET /api/v2/strategy/rsi-scan` — real Wilder RSI over real cached `ohlcv_bars`. `FINAL_ANALYSIS.md`'s "🟠 Mock" rating for this is stale. |

### `opportunities` — Opportunity Feed

| Widget | Verdict | Evidence |
|---|---|---|
| Autonomous Opportunity Feed | REAL | `GET /api/v2/opportunities` — real `agent_predictions` ≥60% confidence, 24h window |

### `portfolio` — Holdings

| Widget | Verdict | Evidence |
|---|---|---|
| Active Asset Positions Ledger | REAL | Real `portfolioData`; market value/unrealized P&L computed live |
| Stop-Loss/Take-Profit columns | MOCKED | Client-only `entryPrice*0.95`/`*1.15` — does not match the real `PortfolioMonitor` ±5%/-3% thresholds it implies |
| EMERGENCY LIQUIDATION button | BROKEN | Calls `POST /api/v1/portfolio/liquidate` — **this route does not exist anywhere in the backend** (confirmed via repo-wide grep; only present in the disconnected `archive/python-platform/`). Clicking it 404s. `FINAL_ANALYSIS.md` rated this real — it is not. |
| REBALANCE ALL button | BROKEN | Same finding: `POST /api/v1/portfolio/rebalance` does not exist. 404s on click. |
| Portfolio Stress Testing | REAL | `GET /api/v2/portfolio/stress-test` — real holdings + real `settings.maxPortfolioDrawdownPct` gate check |
| Automated Task Scheduler | MOCKED (partially dead) | `POST/DELETE /api/v1/scheduler` genuinely stores/deletes tasks in an in-memory array — but **nothing ever reads or executes `scheduledTasks`**; no cron ever fires. The created task also has no real `nextRun` value even though the UI renders one. |

### `agents` — Agent Network

| Widget | Verdict | Evidence |
|---|---|---|
| Network Topology & Data Flow (`DigitalTwinVisualizer`) | REAL | Subscribes to real WS events (`MARKET_DATA`, `TRADE_IDEA_GENERATED`, `RISK_ASSESSMENT_COMPLETED`, `ORDER_EXECUTED`) |
| "ATOS Operating Deck" — Worker grid, Opportunity Discovery Desk, News Intelligence stream | BROKEN | `ChiefTraderAgent.tsx` fetches real `/api/v1/autobot`, but `workers`/`discoveredOpportunities`/`newsIntelligence`/`orchestratorWorkflows` on `TradingEngine.state` are declared and returned by the route yet **never populated anywhere** in the backend. Once the real (always-empty) fetch resolves, the fallback-mock data these panels show is replaced with nothing — worse than pure mocking, since it silently flips from "looks populated" to "looks broken" over the page's own lifetime. The "Total services online: 10/10" label is a hardcoded string, never wired to anything. |
| Orchestrator Workflows panel | NOT_IMPLEMENTED | Correctly shows "No active workflows" — no fallback masking the empty real state |
| Internal Event Bus Stream panel | REAL | Reads `atosData.eventBus`, genuinely populated by `TradingEngine.logHistory()` |
| Analyst Task Dispatcher sub-tab | MOCKED | `setTimeout` + templated strings; a `const rand = 0.6` that isn't actually random |
| Multi-Layer Veto Gate sub-tab | MOCKED | Hardcoded symbol templates with pre-baked outcomes; veto logic runs entirely client-side |
| Swarm Intelligence Nodes — Win-Rate chart | MOCKED | `mockWinRateData` — flat constant values for all 30 days |
| Performance Threshold Alert banner | MOCKED | Computed from the same static mock array |
| Active Regime Casting Weights | NOT_IMPLEMENTED (unlabeled) | Empty container, no content and no explicit "not implemented" message either — an honesty *gap*, not a fabrication |
| System Latency panel | MOCKED | `mockSystemLatencyData` — fixed array, never updates |
| Agent Node Stability Snapshot | MOCKED | Derived purely from the mock arrays above |
| Agent Hyperparameter Tuning sliders | MOCKED | Local-only state; labeled "Live Hot-Reload Active" but never reaches any real agent |
| Cross-Regime P&L Contribution Heatmap | MOCKED | `mockHeatmapData` — static invented values |
| Trade Execution Correlation Matrix | MOCKED | Three entirely hardcoded correlation matrices, no fetch call in the file |
| Multi-Agent Dialogue Graph | MOCKED | Fixed node/link topology; a `Date.now() % 1000`-driven animation loop fires simulated messages on a timer |
| Agent ROI & Metric Comparison table | REAL | Real `agentPerformanceStats` via `/api/v1/performance`. **Confirmed fixed** (was flagged fake earlier this engagement, then repaired mid-session). |
| Agent ROI — ROI Trend chart | NOT_IMPLEMENTED | Honest explicit state — `agent_performance_stats` is snapshot-only, no real time series exists |
| Swarm Collaboration & Consensus Transcript | MOCKED | `mockSwarmTranscripts` — fully invented dialogue text |

### `news` — News Intel

| Widget | Verdict | Evidence |
|---|---|---|
| All panels (`NewsDashboardTab.tsx`) | REAL | Real `/api/v1/news/timeline`, `/news/articles`, `/news/providers`, backed by the real `newsEngine`/`news_articles` table. **Confirmed still fully real, no regression.** |

### `intelligence`

| Widget | Verdict | Evidence |
|---|---|---|
| Momentum Engine (RSI/MACD) | PARTIAL | Backed by real `TechnicalAgent` math via a real `CALCULATION_COMPLETED` event; "Score" sub-field is a permanent hardcoded fallback |
| Trend Engine (EMA200/ADX/Score) | PARTIAL/MOCKED | `trend.primary`/`strength` are real (though the backend's own comment calls the strength calc a "dummy"); `ema200`/`adx` are never set at all |
| Structure / Smart Money / Options Flow / Volatility / Macro Env / Historical Analogs engines | MOCKED | Corresponding backend fields are **never assigned anywhere** — every value shown is the JSX fallback |
| News Agent card | MOCKED | Backed by a static value set once at boot, never updated afterward |
| Live Evidence Weighting Engine table | MOCKED | Backend field never set; always renders the hardcoded fallback |
| AI Verification & Consensus Engine | MOCKED | Static values set once at boot; `agreement` field never set at all |
| Live Evidence Graph & Consensus (D3-style debate tree) | MOCKED | 100% static JSX, not backed by any state variable |

### `learning` — Learning & Evolution

| Widget | Verdict | Evidence |
|---|---|---|
| Top stat row (agents w/ history, avg win rate, learned rules count) | REAL | `GET /api/v2/agents/learning-summary` — real `agentPerformanceStats` + `learnedRules` |
| Per-agent scorecard table | REAL | Same source as above |
| Weight Evolution (7D) chart | MOCKED | Static fixed-height bars with hardcoded tooltip labels for agent names that don't match any real Argus agent |
| Kelly Position-Sizing Learner | MOCKED | Static values, no backend Kelly-sizing system exists. **Confirmed still fake** — explicitly deferred earlier this engagement. |
| Autonomous Post-Trade Post-Mortem (RL) | MOCKED | Fully invented narrative text. **Confirmed still fake** — explicitly deferred. |
| Strategy Backtest Engine chart + stats | MOCKED | `mockBacktestData` (all-zero series) plus hardcoded stat tiles regardless of selection; panel claims "real backtests run locally" — they are not wired in. **Confirmed still fake** — explicitly deferred. |
| Agent Learning & Evolution Journal | NOT_IMPLEMENTED | Honestly empty — the real backing field (`TradingEngine.state.learningJournal`) exists but is never written to anywhere, so the empty state is accurate, not a workaround |

### `memory` — VEC Event Memory

| Widget | Verdict | Evidence |
|---|---|---|
| Semantic query — "Precedent Analysis Verdict" summary | PARTIAL | Real Gemini call when configured; silently falls back to a canned string dressed up as a real match when not, with no way for the user to distinguish the two |
| "Closest Matching Vector precedents" list | BROKEN (dead) | Scores against `historicalPrecedents`, an array **declared and never populated anywhere** in the codebase — always empty, the list never renders anything regardless of query, despite the UI presenting a working search experience |
| Quality Feedback Loop (thumbs up/down) | MOCKED | Posts to a real route that returns `{ok:true}` and discards the input; the backend's own comment says "Simulate updating vector embeddings weight" |
| Vector Space Clustering (t-SNE) map | NOT_IMPLEMENTED | Honest explicit state — no real embedding/vector-store infrastructure exists. **Confirmed fixed** (previously 12 hardcoded fake crisis points). |

### `activity` — Activity Log

| Widget | Verdict | Evidence |
|---|---|---|
| System Activity Logs table + CSV export | REAL | Real `TradingEngine.state.history`, populated by real EventBus listeners. Not persisted across restarts (capped in-memory ring buffer), but genuinely real, not fabricated. |

### `audit` — Observability & Trade Tracing

| Widget | Verdict | Evidence |
|---|---|---|
| Recent Transactions table + `TransactionObservatory` replay modal | REAL | `GET /api/v2/transactions`; replay joins `consensusDecisions`/`consensusEvidence`/`riskAssessments`/`riskGateResults`/`trades`/`fills`/`eventTraces` — all real tables, no recomputation. **Confirmed still real, no regression.** |

### `documentation`

| Widget | Verdict | Evidence |
|---|---|---|
| Course content (static architecture/math explanations) | N/A by design | Pure static prose, not data-backed by design. Spot-checked several factual claims (risk-cap formula, 0.75 approval threshold, 20% concentration cap, gate ordering) against the real `RiskEngine`/`ChiefTraderAgent` source — they match. |
| Course-progress bar | PARTIAL | Real, correctly-computed client state, but not persisted — resets on refresh |

### `evaluation` — Agent Evaluation

| Widget | Verdict | Evidence |
|---|---|---|
| Consensus Weight Distribution, Agent Leaderboard | REAL | `GET /api/v2/agents/performance` — direct read of `agent_performance_stats`. **Confirmed still real, no regression.** |

### `validation` — System Validation Suite

| Widget | Verdict | Evidence |
|---|---|---|
| "Run Integrity Checks" (6 checks) | REAL | `GET /api/v1/system/integrity` → `IntegrityValidator.ts` — real `sqlite_master` schema check, real `BrokerManager` capabilities, real `ai_providers` row check, real news-provider check, real local-AI `/health` probe. **The previously-flagged fake-RNG pass/fail is confirmed gone.** |
| "Dual-Engine Volatility & Gating Simulator" | MOCKED | `SystemOptimizer.tsx` — `setTimeout` computing feedback purely from hardcoded constants and the user's own dropdown selections. No backend call. |
| "High-Concurrency Engine & Pool Optimizer" / Stress Test | MOCKED — **newly found, real regression risk** | `SystemOptimizer.tsx` uses the *exact same* `(Date.now() % 1000 / 1000)` fake-RNG idiom that was just fixed in the sibling `SystemValidationSuite` component **in this same tab**. Event loop lag, DB pool utilization, API concurrency, query latency, and the live log feed are all synthetic, client-only `setInterval` output. Anyone concluding "the Validation tab was fixed" from the Integrity Checks fix alone would be wrong — this second component in the same tab still fully fabricates its numbers. |

### `deployment`

| Widget | Verdict | Evidence |
|---|---|---|
| "Run Quant Audit" self-assessment quiz | MOCKED (honestly disclosed) | Score derived entirely from the user's own dropdown picks; the panel's own copy explicitly says this doesn't inspect the real running instance |
| "Real Argus System Integrity Check" panel | REAL | Same real `GET /api/v1/system/integrity` as the Validation tab — a genuinely distinct, real check sitting next to the quiz |

### `kronos` — Kronos Model

| Widget | Verdict | Evidence |
|---|---|---|
| Status banner (Ready/Unavailable) | REAL | Real `/health` probe against the local Chronos service via `KronosModelManager` |
| Model Version | REAL | Set from the real `/health` response when reachable |
| GPU Usage / Memory Usage / Inference Time tiles | MOCKED — **newly found** | Set once in the `KronosModelManager` constructor (`'0%'`/`'0 MB'`/`0`) and never updated anywhere. Renders as live-looking stats rather than the honest `DATA_UNAVAILABLE` style used elsewhere in the same tab for genuinely-not-implemented metrics. |
| Engine Configuration | NOT_IMPLEMENTED | Honest literal `"--"` |
| Historical Performance (Directional Accuracy/MAE/RMSE/MAPE) + ATR-band chart | NOT_IMPLEMENTED | Honest `DATA_UNAVAILABLE` state, empty chart |

### `settings`

| Widget | Verdict | Evidence |
|---|---|---|
| Secrets manager (Broker/LLM/Market Data password fields) | BROKEN — **newly found** | Calls `GET/PUT /api/v1/secrets` and `POST /api/v1/secrets/test` — **none of these three routes exist anywhere in the backend** (real logic for this exists in `server.ts` - `SECRET_SPECS`, `secretsStatus()`, `writeSecretsFile()` - but is never wired to an Express route). The panel silently renders empty; Save/Test buttons 404 inside empty `catch{}` blocks with no visible error. |
| AI Provider Management (Providers/Routing/Usage/Playground) | REAL | Real `aiProviders`/`aiUsage`/`agentRoutingOverrides` tables via `configRoutes.ts` |
| Connection Status Dashboard — status badges | PARTIAL | Real underlying check, but `hasAlpaca`/`hasGemini` actually mean "any broker/provider row exists," not specifically Alpaca/Gemini |
| Connection Status Dashboard — Latency/Uptime/Last Ping | MOCKED | Hardcoded literals (`45ms`, `99.9%`, `'Just now'`), despite the panel's own header claiming "real-time" metrics |
| Broker Management (adapter list, capability pills, Test Connection) | REAL | Real `BrokerManager.getAvailableBrokers()`. **Confirmed this is the component that already fixed the fake-Robinhood/hardcoded-buying-power anti-pattern** — still fixed, no regression. |
| Chaos Mode Swarm Stress Testing Suite | PARTIAL/dead | Config round-trips through a real, persistent in-memory store — but those config fields are **never read anywhere** in the running pipeline; toggling this panel has zero real effect. "Target Agent Nodes" list names fictional agents that don't exist in this codebase. |
| Adaptive Architecture — Regime Switching Core | BROKEN — **newly found** | Reads `autoBotConfig.regimeState.regime/adx/volatilityRatio`; the real backend field uses entirely different field names (`current`/`volatility`/`detectedAt`) and is never reassigned after boot. Permanently blank/undefined — not merely "not implemented," but a genuine field-name mismatch on top of dead backend state. |
| Adaptive Architecture — Macro Shock Generator | PARTIAL | Real Gemini call (or a real hardcoded fallback scenario) and real persistence — but nothing in the actual agent pipeline ever reads the persisted shock state, so it has no real effect on trading behavior despite being framed as a resilience test |
| Adaptive Architecture — Prompt Evolution Core | NOT_IMPLEMENTED | Correctly gated: button disabled, backend returns `501` with an honest explanation. A good example of honest gating done right. |
| Token Consumption & Projected Costs | REAL | Real `ai_calls` table, grouped by real agent. **Confirmed fixed, no regression.** |
| Outbound Webhooks (register/list/test/toggle/delete) | PARTIAL/dead feature | CRUD and "Test Connection" are genuinely real; storage is in-memory (lost on restart, not a DB table); and the panel's advertised purpose — firing on real risk-veto/daily-loss events — is dead code: `triggerWebhooks()` is exported and imported but **never called anywhere** in the codebase. No real trading event will ever fire a configured webhook today. |

---

## Cross-cutting findings not tied to one tab

**Broker-selection dropdowns** (explicitly re-investigated, per the prior "fake broker dropdown" flag): the **Settings tab's** `BrokerManagement.tsx` and `SetupWizard.tsx` both correctly offer only real, registered broker ids (`internal_paper`, `alpaca`, `questrade`, `ibkr`, `coinbase`) and correctly flag Questrade's non-functional order-placement status. The **Trading Arena tab's** "Live Broker Feed" panel was *not* fixed alongside those and still offers `Robinhood` and `Charles Schwab` — brokers with no adapter anywhere in this codebase — as if selectable. **This is a half-fixed issue, not a fully-fixed one.**

**Cancel-order UI gap**: this hardening pass's own Phase 2 added a real `POST /api/v2/trading/cancel-order/:id` backend route with full test coverage. No frontend button anywhere calls it. The capability is real and tested at the API level but not yet reachable by a user.

---

## Tally

Counting each of the 20 tabs by its *worst* verdict among its own widgets (a tab with even one MOCKED/BROKEN widget is not "fully real"):

- **Fully real, zero fabrication or breakage**: `observatory`, `scanner`, `opportunities`, `news`, `activity`, `audit`, `evaluation` — **7 of 20**.
- **Real core with an honest NOT_IMPLEMENTED gap only** (no fabrication, no breakage): `kronos` is close but disqualified by the GPU/Memory/Inference tiles finding; none of the remaining tabs qualify for this tier once every widget is checked.
- **Contains at least one MOCKED widget**: `dashboard`, `command`, `arena`, `agents`, `intelligence`, `learning`, `memory`, `validation`, `deployment`, `settings` — **10 of 20**.
- **Contains at least one BROKEN widget** (calls a nonexistent route, or reads a field that will never populate): `dashboard`, `command`, `portfolio`, `agents`, `memory`, `validation` (indirectly, via the sibling-component confusion risk), `kronos`, `settings`, `arena` — **9 of 20**, several overlapping with the MOCKED set above.
- **`documentation`** is not scored (static content by design, not a data-backed tab).

This is a **lower** fully-real count than `CURRENT_STATE_BASELINE.md`'s mid-session 7/20 might suggest at a glance, but it's a *like-for-like* number in a different sense: several tabs that document said were "real" (Portfolio's Liquidate/Rebalance, Arena's Swarm Decision Outcomes) are now confirmed **BROKEN**, while several it said were fake (Strategy Scanner, Opportunity Feed, Agent ROI comparison, Learning & Evolution's top KPIs) are now confirmed **REAL**. The net tally landing at the same rough magnitude is coincidental, not a sign nothing changed — the *composition* of which 7 are real has shifted substantially, and this pass found real breakage (BROKEN) that no prior pass had categorized as a distinct, worse-than-mocked failure mode.

## What this means for the hardening task's own scope

Per Phase 11's explicit instruction, none of the MOCKED/NOT_IMPLEMENTED findings above were "fixed" as part of producing this document — that would be exactly the "implement fabricated areas merely for visual completeness" the phase explicitly warns against. The **BROKEN** findings (404 routes, dead field reads, orphaned backend logic) are a different category — they're real bugs, not fabrication-by-design — and are flagged here for the user's own prioritization, not fixed unilaterally, since fixing nine tabs' worth of broken wiring was not part of the 15-phase plan this hardening pass was scoped against.
