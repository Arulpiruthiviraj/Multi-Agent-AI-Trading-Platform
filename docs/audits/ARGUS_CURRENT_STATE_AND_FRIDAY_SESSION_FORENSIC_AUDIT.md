# ARGUS — Current State & Friday Session Forensic Audit

**Audit date:** 2026-08-23 (Sunday). **Session under investigation:** 2026-08-21 (Friday, the most
recent trading day with any DB activity — confirmed no rows dated 2026-08-22/23 in `trades`,
`risk_assessments`, or `consensus_decisions`). Read-only audit. **No code, configuration, or database
rows were modified to produce this report.** Autobot was not enabled, LIVE was not armed, consensus
was not lowered, no gate was bypassed, nothing was committed.

Evidence classification used throughout: **CODE VERIFIED** (read the current source), **CONFIG
VERIFIED** (read the current `config/*.json` or DB `settings` row), **DATABASE VERIFIED** (direct
SQL query against `data/argus.db`), **TEST VERIFIED** (an existing or newly-added automated test
passes), **RUN VERIFIED** (a command was actually executed this session and its real output
observed), **INFERRED** (a reasonable conclusion from the above, not itself directly observed),
**NOT VERIFIED** (explicitly flagged as an instrumentation or evidence gap).

---

## 1. Executive Summary

Argus did not place a single fully-autonomous trade on Friday 2026-08-21. It evaluated **4,521
trade ideas** across **4,400 ChiefTrader consensus cycles** that day — the pipeline was fully alive,
not idle or crashed — but **not one organic idea ever cleared the 0.75 confidence / 2-independent-agent
consensus bar** (**DATABASE VERIFIED**: `consensus_decisions`, `observability_events`). The only 7
ideas that were ever marked `CHIEF_APPROVED_IDEA` that day were **6 human-initiated manual-override
test trades** (`SOURCE: MANUAL_OVERRIDE — human bypassed ChiefTrader AI consensus`) and **1 genuine
autonomous action** — a risk-exit SELL (IWM) that hit its Daily-Goal-Campaign ATR target and correctly
skipped the debate/min-agent requirement, exactly as designed for exits. Of those 7, RiskEngine passed
4 and rejected 3 (all for real, gate-correct reasons — `duplicate_signal`, `data_freshness`,
`sell_position_exists`). Of the 4 that reached the Order Management Service, **2 were then killed by a
real software defect** — `BROKER_ENVIRONMENT_UNKNOWN` — that this same working session already found
and fixed (see §13). The other 2 (both manual-override) reached the broker and filled.

**This was not a market-conditions excuse, not an OMS/broker/RiskEngine malfunction, and not the OMS
defect either** — the primary root cause is upstream of all of those: **the autonomous consensus layer
never once produced a real signal strong enough to pass its own bar.** Separately, a real, correctly-
designed safety event also occurred: at 17:46 ET, `PortfolioReconciliation` found a genuine $424.08
mismatch against IBKR Gateway (a GLD position present locally but missing remotely) and paused trading
for ~24 minutes until an operator reviewed it — this is the system working exactly as documented, not
a defect.

---

## 2. Current Source of Truth

| Item | Value | Evidence |
|---|---|---|
| Git branch | `main` | **RUN VERIFIED** (`git rev-parse --abbrev-ref HEAD`) |
| HEAD commit | `dfa4bac378fee2eb768bfd831bfe8e976880bdde`, 2026-08-23 18:48:55 -0400 | **RUN VERIFIED** |
| Working tree | Substantial uncommitted changes: the prior documentation-reorg `git mv` renames (21 files into `docs/audits/archive/`), this session's `BROKER_ENVIRONMENT_UNKNOWN` fix (`OrderManagement.ts`, its tests), and the new Java institutional-quant-layer files (`quant-core-java/.../institutional/`, `.../strategy/institutional/`) | **RUN VERIFIED** (`git status --porcelain`) |
| Most recent commits | Five commits since 2026-08-21 covering the Java Quant Core migration phases and a status audit; last real trading activity in `trades`/`risk_assessments`/`consensus_decisions` is 2026-08-21 — nothing dated 08-22/08-23 | **DATABASE VERIFIED** + **RUN VERIFIED** (`git log`) |
| DB size / table count | 62 `sqliteTable(` calls in `schema.ts` (matches `CLAUDE.md`'s own count) | **CODE VERIFIED** |
| `data/argus.db` real date range (`observability_events.ts`) | 2026-08-18T13:05Z – 2026-08-24T00:33Z | **DATABASE VERIFIED** |

**A methodological note, disclosed rather than hidden:** the first pass of this audit's own SQL
queried `observability_events`/`event_traces` using a hand-typed epoch-millisecond window that was
off by exactly one year (`2025-08-21` instead of `2026-08-21`). This was caught by cross-checking
`MIN(ts)`/`MAX(ts)` against the table's real date range before drawing any conclusion from it, and
every number in this report is from the corrected, verified window
(`1787270400000`–`1787356799999` = `2026-08-21T00:00:00.000Z`–`23:59:59.999Z`). This is exactly the
same class of bug flagged in `CLAUDE.md` (`event_traces`/`observability_events` store epoch-ms
**integers**; `trades`/`risk_assessments`/`consensus_decisions`/`agent_predictions` store **ISO-8601
text** — mixing the two comparison styles silently returns zero rows, never an error).

Historical audit documents in this repo (`docs/audits/CURRENT_STATE_AND_LAST_MARKET_RUN_AUDIT.md` and
the archived reports) were **not** treated as current truth. Where this audit's own DB queries confirm
the same facts, that is noted as independent re-verification, not a copy-forward.

---

## 3. Current Architecture Map

```
Alpaca WebSocket (MarketDataWorker) ──emitMarketData()──▶ EventBus (MARKET_DATA / MARKET_DATA_UPDATED)
                                                                 │
        ┌────────────────────────────────────────────────────────┼──────────────────────────────────────────┐
        ▼                        ▼                    ▼          ▼                  ▼                       ▼
  TechnicalAgent          NewsEngine/NewsCatalyst  FundamentalAgent  MacroAgent   KronosForecastAgent   OpportunityScreener
  (RSI/MACD/BB, no LLM)   (RSS+paid APIs, +LLM)    (AlphaVantage+AI) (AlphaVantage+AI) (local Chronos, optional) (cheap rank, one vote)
        │                        │                    │          │                  │                       │
        └───────────────────────────┴────────────────────┴──────────┴──────────────────┴───────────────────────┘
                                                     │  TRADE_IDEA_GENERATED {traceId,symbol,side,confidence,...}
                                                     ▼
                                            gateTradeIdea() / looksLikeListedTicker (DEF-24)
                                                     │
                                                     ▼
                                          ┌─────────────────────┐
                                          │   ChiefTraderAgent   │  weights: agent_performance_stats
                                          │  (consensus + debate)│  bar: 0.75, min 2 independent agents
                                          └─────────┬───────────┘
                                                     │ CHIEF_APPROVED_IDEA (mints transactionId)
                                                     ▼
                                          ┌─────────────────────┐
                                          │      RiskAgent       │
                                          │  RiskEngine.evaluateRisk() — 24 gates, evaluationQueue mutex │
                                          └─────────┬───────────┘
                                                     │ RISK_ASSESSMENT_COMPLETED (persist-then-emit, P0.3)
                                                     ▼
                                          ┌─────────────────────┐
                                          │ OrderManagementService│ authorizeProductionOrder() (BROKER_ENVIRONMENT gate)
                                          └─────────┬───────────┘
                                                     ▼
                                          ┌─────────────────────┐
                                          │    BrokerManager     │──▶ AlpacaBroker / IBKR / InternalPaperBroker
                                          └─────────┬───────────┘
                                                     ▼
                                         trades + fills (unique orderId, cumulativeQuantity)
                                                     │
                                                     ▼
                                    PortfolioReconciliation (independent ~5-min timer, both brokers)
                                                     │  mismatch ⟶ TRADING_PAUSED (never auto-flatten/auto-resume)
                                                     ▼
                                              ORDER_EXECUTED ──▶ WebSocket ──▶ React UI
```

**Per-stage table** (file ownership, start/stop, Autobot dependency — **CODE VERIFIED** this pass):

| Stage | Owning file(s) | Starts | Stops | Autobot-gated? | Can silently fail? |
|---|---|---|---|---|---|
| MarketDataWorker | `src/server/market/MarketDataWorker.ts` (per CLAUDE.md boot order) | Always, on boot | Never (Diagnostics/RiskEngine need the feed even with Autobot off) | No | Reconnect logic exists; a stall shows as `data_freshness` gate failures (observed Friday, see §7) |
| Idea agents (Technical/News/Fundamental/Macro/Kronos/Screener) | `src/server/agents/*` | On boot / timers | System stop | Technical/News/Fundamental/Macro run regardless of Autobot per CLAUDE.md's documented "ticks can still drive Technical/Kronos → pipeline if TRADING_ENABLED" | Individually — a stuck AI call is bounded by `HeavyModelMutex` queue depth (10) |
| ChiefTraderAgent | `src/server/agents/ChiefTraderAgent.ts` (not re-read line-by-line this pass; behavior corroborated entirely from real `consensus_decisions`/`observability_events` rows, not assumed) | Event-driven | — | No (evaluates regardless; gate #2 `autobot_enabled` blocks the resulting BUY downstream, not the debate itself) | Manifests as `AGENT_DISAGREEMENT` (2,991 times Friday) rather than a crash |
| RiskEngine | `src/server/engines/RiskEngine.ts` | Event-driven, `evaluationQueue` mutex | — | No | Fail-closed by design (P0.3) |
| OMS | `src/server/services/OrderManagement.ts` | Event-driven | — | No (SELL/exits never blocked by Autobot-off) | `authorizeProductionOrder` gate — this is exactly where the `BROKER_ENVIRONMENT_UNKNOWN` defect lived (§13) |
| BrokerManager / AlpacaBroker / IBKR adapters | `src/brokers/*` | On `BrokerManager.getInstance().initialize()` at boot | — | No | Timeout → `PENDING`/`UNKNOWN`, never fabricated `FILLED` |
| PortfolioReconciliation | `src/server/.../PortfolioReconciliation.ts` (per CLAUDE.md: independent ~5-min timer) | On boot | Never stops for Autobot-off | **No** — ran all day regardless of Autobot state (149 checks logged Friday, **DATABASE VERIFIED**) | Never auto-flattens, never auto-resumes (confirmed: the one real mismatch stayed `TRADING_PAUSED` until an `admin` actor resumed it, §9) |

No new singleton processes, duplicate writers, or second order paths were found this pass beyond
what `CLAUDE.md` already documents. `architecture.protection.test.ts` (re-run this pass as part of
the full suite, §11) still enforces that `src/server/continuous/` and `src/server/multiAsset/` never
import `OMS`/`RiskEngine`/`BrokerManager` or call `.placeOrder(`.

---

## 4. Friday 2026-08-21 Session Timeline

Timezone: America/New_York (EDT, UTC-4) for narrative times; raw evidence is UTC. RTH = 13:30–20:00
UTC.

| Time (ET) | Event | Component | Trace/Tx ID | Expected | Actual | Result |
|---|---|---|---|---|---|---|
| Overnight–pre-open | Reconciliation ticks every ~5 min, `matches:1` throughout | PortfolioReconciliation | — | Should run regardless of Autobot | Ran continuously, all clean | PASS |
| 09:30 ET (13:30 UTC) | Market opens | MarketDataWorker | — | Ticks flow | `market_hours` gate passed 7/7 times it was evaluated that day (**DATABASE VERIFIED**, `risk_gate_results`) | PASS |
| ~all day | Idea agents evaluate continuously | Technical/Fundamental/Macro/Kronos/Screener | (thousands) | Generate ideas | 4,521 `TRADE_IDEA_GENERATED` (**DATABASE VERIFIED**) | PASS (pipeline alive) |
| ~all day | ChiefTrader runs consensus | ChiefTraderAgent | (4,400 cycles) | Approve ≥0.75 conf, ≥2 agreeing agents | 353 persisted `consensus_decisions` rows, **0 organically approved** (125 BUY rejected avg conf 0.18; 120 HOLD; 108 SELL rejected avg conf 0.27) | **BLOCKED at consensus** |
| 10:06 ET (14:06:14 UTC) | Manual `EMERGENCY_STOP` | `admin` actor via API | `kill_switch_events#69` | Operator-only action | Triggered, then reversed by the same actor 6 seconds later (14:06:20) | Deliberate manual test, not an incident |
| 11:35:05 ET (15:35:05 UTC) | Manual-override BUY IWM | v2System manual-override route → OMS → AlpacaBroker | `manual-override-cc7ef23d…`, tx `ARG-2026-08-21-000090` | Human bypasses ChiefTrader, RiskEngine+OMS still apply | RiskEngine approved; OMS placed; broker filled @ $299.54 | **PASS (human-initiated, not autonomous)** |
| 11:35:07 ET | Manual-override 2nd IWM BUY attempt | same | `manual-override-5fe6c22b…`, tx `-000091` | — | RiskEngine **rejected**: `duplicate_signal` (same-symbol BUY within 60s window) | Gate working correctly |
| 11:35:09 ET | Manual-override ORCL BUY attempt | same | `manual-override-8589190d…`, tx `-000092` | — | RiskEngine **rejected**: `data_freshness` (ORCL quote 5+ min stale) | Gate working correctly |
| 12:42:52 ET (16:42:52 UTC) | Autonomous SELL, IWM, risk-exit | PortfolioManager (risk-exit path, skips debate/min-agents by design) | tx `-000153` | Campaign ATR Target-1 hit → bank scalp | Consensus 0.85 (threshold 0.75, correctly lower for a risk-exit) → RiskEngine approved → OMS → broker filled @ $299.85 | **PASS — the one genuine autonomous action all day** |
| 13:46:17 ET (17:46:17 UTC) | Real reconciliation mismatch | PortfolioReconciliation vs IBKR Gateway (Socket) | `reconciliation_events#800` | GLD: local qty 1, remote qty 0, $424.08 impact | `TRADING_PAUSED` fired automatically | **PASS — fail-closed exactly as designed** |
| 14:10:06 ET (18:10:06 UTC) | Operator resumes | `admin` via `POST /api/v1/system/resume` | `kill_switch_events#72` | Manual ack required, no auto-resume | Resumed ~24 min after the pause, after reviewing evidence | PASS (matches "never auto-resume" invariant) |
| 14:31:08 ET (18:31:08 UTC) | Manual-override SELL SOFI | same route | `manual-override-a1a639a9…`, tx `-000203` | — | RiskEngine **rejected**: `sell_position_exists` (no SOFI position; existingQuantity=0) | Gate working correctly |
| 14:31:14 ET (18:31:14 UTC) | Manual-override BUY TSLA | same route | `manual-override-ba0e11bd…`, tx `-000205` | RiskEngine approves → should reach broker | RiskEngine **approved**, but OMS's `authorizeProductionOrder` rejected: `BROKER_ENVIRONMENT_UNKNOWN` | **Software defect** (fixed this session, §13) |
| 14:31:16 ET (18:31:16 UTC) | Manual-override BUY RIOT | same route | `manual-override-39a499bf…`, tx `-000206` | Same as above | Same `BROKER_ENVIRONMENT_UNKNOWN` rejection | **Software defect** (fixed this session, §13) |
| 16:00 ET | RTH close | — | — | — | No further trading activity that day in DB | — |

**Exact last successful stage reached, per idea:**

```
Organic (non-override, non-risk-exit) BUY/SELL ideas:  4,521 generated → 0 ever reached CHIEF_APPROVED_IDEA
                                                        STOPPED AT: ChiefTrader consensus (never hit 0.75 + 2 agents)

Manual-override IWM BUY #1:      Consensus(override) ✓ → RiskEngine ✓ → OMS ✓ → Broker ✓ → FILLED
Manual-override IWM BUY #2:      Consensus(override) ✓ → RiskEngine ✗ (duplicate_signal)      STOPPED AT: RiskEngine
Manual-override ORCL BUY:        Consensus(override) ✓ → RiskEngine ✗ (data_freshness)         STOPPED AT: RiskEngine
Autonomous IWM SELL (risk-exit): Consensus(risk-exit) ✓ → RiskEngine ✓ → OMS ✓ → Broker ✓ → FILLED
Manual-override SOFI SELL:       Consensus(override) ✓ → RiskEngine ✗ (sell_position_exists)   STOPPED AT: RiskEngine
Manual-override TSLA BUY:        Consensus(override) ✓ → RiskEngine ✓ → OMS ✗ (BROKER_ENVIRONMENT_UNKNOWN) STOPPED AT: OMS
Manual-override RIOT BUY:        Consensus(override) ✓ → RiskEngine ✓ → OMS ✗ (BROKER_ENVIRONMENT_UNKNOWN) STOPPED AT: OMS
```

---

## 5. Trade Funnel

| Stage | Count | Evidence |
|---|---|---|
| Trade ideas generated (all agents, all symbols) | **4,521** (`observability_events`) / 4,539 (`event_traces`, small population-method difference between the two logging paths — not reconciled to the single-digit, noted as a minor gap) | **DATABASE VERIFIED** |
| ChiefTrader consensus cycles started/completed | **4,400 / 4,400** | **DATABASE VERIFIED** |
| Persisted `consensus_decisions` rows | 360 (125 BUY rejected, 120 HOLD, 108 SELL rejected, 7 approved) | **DATABASE VERIFIED** |
| Gap between 4,400 consensus cycles and 360 persisted decision rows | **NOT AVAILABLE — instrumentation gap.** `observability_events`'s `CHIEF_CONSENSUS_STARTED/COMPLETED` counts every consensus evaluation cycle; `consensus_decisions` appears to persist a row only for a subset (plausibly only once a minimum-agent/quorum condition is even evaluable — not confirmed by reading `ChiefTraderAgent.ts`'s persistence condition this pass). This is a real, disclosed gap, not fabricated as either 4,400 or 360. | **NOT VERIFIED** |
| Pre-consensus rejections (`TRADE_IDEA_REJECTED`) | 432 (sampled reasons: MacroAgent/FundamentalAgent-side ideas failing `gateTradeIdea`/ticker-validity checks) | **DATABASE VERIFIED** |
| `DESK_NO_TRADE` (agent explicitly abstains) | 5,050 | **DATABASE VERIFIED** |
| `CHIEF_APPROVED_IDEA` | **7** (6 manual-override, 1 autonomous risk-exit) | **DATABASE VERIFIED** |
| Reaching RiskEngine (`risk_assessments` rows) | 7 | **DATABASE VERIFIED** |
| Approved by RiskEngine (all 24 gates) | 4 | **DATABASE VERIFIED** |
| Rejected by RiskEngine | 3 (`duplicate_signal` ×1, `data_freshness` ×1, `sell_position_exists` ×1) | **DATABASE VERIFIED** |
| News-veto blocks that day (separate from the above 3; these hit ideas that never became `CHIEF_APPROVED_IDEA` at all, so they don't appear in the 7) | 13 distinct trace IDs found with `news_veto` gate failures, `matchingClusters:1–4` | **DATABASE VERIFIED** |
| Market-hours rejections | 0 (7/7 passed) | **DATABASE VERIFIED** |
| Autobot-disabled rejections | 0 (7/7 passed `autobot_enabled`) | **DATABASE VERIFIED** |
| Reaching OMS (`trades` rows inserted) | 4 | **DATABASE VERIFIED** |
| OMS `BROKER_ENVIRONMENT_UNKNOWN` rejections | **2** (TSLA, RIOT) | **DATABASE VERIFIED** |
| Reaching broker (order accepted) | 2 | **DATABASE VERIFIED** (`ORDER_ACCEPTED` ×2 in `event_traces`) |
| Filled | 2 (both manual-override/risk-exit, 0 organic) | **DATABASE VERIFIED** |
| `ORDER_EXECUTED` total events | 6 (vs. an expected 4 matching the 4 `trades` rows) | **NOT AVAILABLE — instrumentation gap.** The +2 was not traced to a specific cause this pass (candidates: the RiskEngine-rejected ideas emitting a terminal-style event before ever reaching OMS's own insert, which would explain it without being a defect — not confirmed by code read this pass). | **NOT VERIFIED** |

**Organic (fully autonomous, non-override, non-risk-exit) trades placed: 0.** This matches
`CLAUDE.md`'s and the pre-existing `organic_paper_soak_status.ts` script's standing claim of
`0 / 30 trades · 0 / 10 sessions` — independently re-derived from raw DB rows in this pass, not
copied from that script's output.

---

## 6. Exact Reason for Zero (Organic) Trades

**Primary root cause, with evidence:** the consensus layer's own math never cleared its bar. Sampled
`TRADE_IDEA_GENERATED` confidences from Friday: `IWM BUY 0.569` (TechnicalAgent), `DIA BUY 0.563`
(TechnicalAgent), `MSFT BUY 0.417` (OpportunityScreener) — all comfortably below the `0.75`
`consensusApprovalThreshold` (**CONFIG VERIFIED**, `config/tradingSafety.json`). The aggregate
`consensus_decisions` rows confirm this isn't a sampling artifact: **125 BUY consensus attempts,
average weighted confidence 0.179**; **108 SELL attempts, average 0.267** — nowhere near 0.75 on
average, and evidently never enough on any single attempt either (0 organic approvals across the
whole session). `AGENT_DISAGREEMENT` fired 2,991 times — the majority of consensus cycles), consistent
with the `minIndependentAgreeingAgents: 2` bar (**CONFIG VERIFIED**) frequently not being met even
when one agent alone was confident.

**This was not:**
- A RiskEngine problem — RiskEngine only ever saw 7 ideas all day (because only 7 ever cleared
  ChiefTrader), and correctly evaluated all 24 gates on each.
- An OMS or broker problem, for the *organic zero-trade* outcome specifically — OMS/broker were never
  reached by an organic idea because none survived consensus. (OMS *did* have a real defect that day,
  but it only affected 2 manually-initiated test trades, not the organic outcome — see §13.)
- A market-hours or Autobot-disabled problem — both gates passed 7/7 times evaluated.
- A "market had no opportunities" excuse asserted without evidence — 4,521 ideas were generated;
  the system had plenty of raw material. The bar these ideas needed to clear (0.75 confidence,
  2 independent agents) was simply not met organically that day.

---

## 7. Target / Expectation Analysis

`settings.daily_target_amount = 100`, `daily_target_type = 'DOLLAR'`, `target_achieved_action =
'CONTINUE'`, `campaign_enabled = 1` (**DATABASE VERIFIED**, current `settings` row — plausibly
unchanged since Friday given no later trading-day activity exists to have reset it, but not itself
directly timestamped to Friday, so this specific row's *historical* value on Friday is **INFERRED**,
not directly DATABASE VERIFIED for that exact day).

This target is **CORRECTLY IMPLEMENTED as advisory/telemetry, not trade-forcing** — direct evidence
for this, not just documentation: the one real autonomous action of the day (`IWM SELL`) was an
**exit**, explicitly reasoned `"[Risk Exit] EXIT_CODE=TARGET_REACHED Campaign intraday ATR Target-1
($299.80, 1.25x ATR) — bank scalp toward daily goal."` The campaign system influenced *when to bank a
gain on an already-open position*, not whether to force a new entry, and did not touch the consensus
threshold math anywhere in this session's evidence (all 125 BUY consensus attempts still used
`threshold: 0.75`, never a lowered value). `target_achieved_action='CONTINUE'` additionally means the
$100 target, even if reached, would not have soft-locked further BUYs that day — the system was in
its most permissive campaign mode, and it still did not force a single organic entry.

**Was Argus supposed to force trades to reach the target? No — and it did not.** The target system is
correctly disconnected from forcing execution.

---

## 8. Autobot Lifecycle Audit

`settings.auto_bot_enabled = 1` currently (**DATABASE VERIFIED**); `risk_gate_results` shows gate #2
`autobot_enabled` passed all 7/7 times it was evaluated Friday (**DATABASE VERIFIED**), consistent
with Autobot having been ON for at least those 7 evaluations. `auto_trade_schedule_enabled = 0` —
the scheduled on/off window is not in use; Autobot is a manual, standing toggle in the current
configuration.

Per `CLAUDE.md` (not re-derived line-by-line from `TradingEngine.ts`/`SystemBootstrap.ts` source in
this pass — carried forward as **CODE VERIFIED in an earlier pass this session**, not re-read here):
MarketDataWorker always starts regardless of Autobot; `system.stop` does not stop it; reconciliation
is independent of Autobot (**directly re-confirmed this pass** — 149 reconciliation checks ran all day
regardless of the two kill-switch state changes); SELL/exit ideas are never blocked by Autobot-off,
only new BUY is (gate #2 specifically says "New **BUY** requires Autobot on. SELL/exits are not
blocked by Autobot-off.").

No evidence this pass of Autobot appearing ON while workers were not running, or vice versa — the
149 reconciliation ticks and 6,063 technical-analysis cycles logged throughout the day are consistent
with workers running continuously and independent of the two kill-switch toggles (which affected
`trading_state`, a different flag from `auto_bot_enabled`).

---

## 9. Complete Trading Gate Map (Friday, as Actually Evaluated)

| # | Gate | Friday pass/fail (of 7 risk_assessments) | Config source | Notes |
|---|---|---|---|---|
| 1 | `emergency_stop` | 7/0 | `tradingState` | Passed every time an assessment ran; the one `EMERGENCY_STOP` toggle (14:06 ET) was reversed 6s later, outside any assessment window |
| 2 | `autobot_enabled` | 7/0 | `settings.auto_bot_enabled` | — |
| 3 | `same_symbol_cooldown` | 7/0 | `sameSymbolCooldownMs=300000` | — |
| 4 | `post_loss_cooldown` | 7/0 | `postLossCooldownMs=900000` | — |
| 5 | `daily_trade_limit` | 7/0 | `maxDailyTrades` | — |
| 6 | `duplicate_signal` | 6/1 | `duplicateSignalWindowMs=60000` | Blocked the 2nd IWM manual-override BUY attempt (correct — a real duplicate within 60s) |
| 7 | `invalid_account_equity` | 7/0 | broker equity | — |
| 8 | `daily_loss` | 7/0 | `dailyLossLimit` | — |
| 9 | `consecutive_loss` | 7/0 | `maxConsecutiveLosses=3` | — |
| 10 | `portfolio_drawdown` | 7/0 | `maxPortfolioDrawdownPct` | — |
| 11 | `order_rate_limit` | 7/0 | `maxOrdersPerMinute` | — |
| 12 | `market_hours` | 7/0 | Alpaca `/v2/clock` | All 7 assessments occurred during RTH |
| 13 | `data_freshness` | 6/1 | `stalePriceThresholdMs=300000` | Blocked the manual-override ORCL BUY (quote ~309s stale — a real staleness, not a bug) |
| 14 | `news_veto` | 6/1 (of the 7 that reached risk_assessments); separately, 13 distinct pre-CHIEF_APPROVED trace IDs also failed this gate on ideas that never got this far | `newsVetoWindowMs=14400000`, `newsVetoMinImpactScore=80` | Direction-blind, exactly as documented |
| 15 | `price_validity` | 7/0 | `looksLikeListedTicker` | — |
| 16 | `order_notional_cap` | 7/0 | `maxTradeSize` | — |
| 17 | `symbol_concentration` | 5/0 | `maxSingleSymbolConcentrationPct=0.20` | (5, not 7 — `sell_position_exists`-only assessments skip position-sizing-dependent gates per the documented recording behavior) |
| 18 | `open_positions_cap` | 5/0 | settings | — |
| 19 | `sector_concentration` | 5/0 | `maxSectorConcentrationPct=0.40` | — |
| 20 | `correlation_exposure` | 5/0 | `correlationThreshold=0.7` | — |
| 21 | `sufficient_size` | 7/0 | `stopLossAssumptionPct=0.05` | — |
| 22 | `sell_position_exists` | 1/1 | SELL only | Blocked the manual-override SOFI SELL (no open SOFI position — correct) |
| 23 | `argus_capital_allocation` | 7/0 | `settings.budget=2000` | — |
| 24 | `daily_buy_notional` | 7/0 | `maxDailyBuyNotionalDollars` | — |

**Upstream of RiskEngine**, the gate that actually mattered Friday was the **ChiefTrader consensus
bar** (0.75 confidence, min 2 independent agents) — not in the numbered 24-gate list at all, evaluated
4,400 times, passed organically 0 times.

---

## 10. Quant / Strategy Engine Audit

`agent_predictions` counts for Friday (**DATABASE VERIFIED**): `KronosEngine 3,051`, `TechnicalAgent
852`, `FundamentalAgent 343`, `MacroAgent 279`, `QuantEngine 220`, `OpportunityScreener 118`,
`PortfolioManager 1`. All the documented idea-generating agents were actively producing predictions —
none were silently idle. `QuantEngine`'s 220 predictions confirm `QUANT_ENGINE_ENABLED=true` was
active that day (per `CLAUDE.md`, this cycle is off by default) — **CODE/CONFIG note:** this pass did
not re-verify the live `.env`'s current `QUANT_ENGINE_ENABLED` value against Friday's, so whether it
is *still* on today is **NOT VERIFIED** here (it was clearly on Friday, per the prediction volume).

This pass did not re-audit which of the 5 CORE vs. experimental quant strategies specifically
produced those 220 `QuantEngine` predictions (would require reading `quant/StrategyEngine.ts`'s
per-call strategy-id dispatch and cross-referencing `quant_assessments` rows — not done this pass,
flagged as **NOT VERIFIED** rather than assumed). Given the overall consensus-layer bottleneck already
fully explains the zero-trade outcome (§6), further strategy-level attribution would not change the
primary conclusion, so it was not pursued to preserve audit scope.

---

## 11. Performance / Concurrency Observations

No hangs, deadlocks, or crash evidence found in this pass's evidence for Friday: `TECHNICAL_ANALYSIS_STARTED`
and `_COMPLETED` counts are exactly equal (6,063 = 6,063), `CHIEF_CONSENSUS_STARTED` and `_COMPLETED`
are within 16 of each other (4,416 vs 4,410 in `event_traces` — a small in-flight tail at the query
boundary, not a stuck cycle), and reconciliation ticked on-schedule (~5 min) all day without a gap.

One real, already-known defect was active in production code on Friday and is the subject of §13
below — not a concurrency/performance issue, a plain logic bug in trading-mode resolution.

No new CRITICAL/HIGH findings surfaced in this pass beyond what's already tracked. This audit did not
re-run a dedicated event-loop-blocking/profiling pass (e.g., instrumenting `AI_CALL` latency
distributions) — flagged as **NOT VERIFIED**, not asserted clean.

---

## 12. Previous-Fix Regression Check

| Claim | Current status | Evidence |
|---|---|---|
| `PAPER_TRADING_ONLY` enforcement | PASS | **CONFIG VERIFIED**: `.env` has `PAPER_TRADING_ONLY=true`, `ARGUS_TRADING_MODE=PAPER`; `settings.trading_mode='PAPER'` (**DATABASE VERIFIED**) |
| `evaluateLiveReadiness()` → `LIVE_NO_GO` | PASS | **RUN VERIFIED** this session (`npx tsx scripts/organic_paper_soak_status.ts` → `"live":"NO-GO"`, exited cleanly) |
| Consensus threshold = 0.75 | PASS, unchanged | **CONFIG VERIFIED**: `config/tradingSafety.json.consensusApprovalThreshold === 0.75` |
| Minimum independent agents = 2 | PASS, unchanged | **CONFIG VERIFIED**: `minIndependentAgreeingAgents === 2` |
| News veto not bypassed | PASS | **DATABASE VERIFIED**: gate fired and blocked real ideas Friday (13+ trace IDs) |
| RiskEngine not bypassed | PASS | **DATABASE VERIFIED**: every one of the 7 `CHIEF_APPROVED_IDEA`s (including manual-override ones) still went through `risk_assessments`/`risk_gate_results` — override bypasses *ChiefTrader*, not RiskEngine, exactly as its own persisted reasoning states |
| OMS remains sole production order path | PASS | **CODE VERIFIED**: `grep .placeOrder(` across `src/` shows only `OrderManagement.ts` as a real caller outside broker-adapter definitions and test files; `architecture.protection.test.ts` (green, §on full suite) still enforces this |
| No second kill switch | PASS | Only `kill_switch_events` state machine used Friday (`EMERGENCY_STOP`/`TRADING_PAUSED`/resume) |
| Duplicate process / single writer | Not independently re-tested this pass (would require a live concurrent-open reproduction) | **NOT VERIFIED** this pass — carried forward from earlier session verification, not re-proven here |
| Reconciliation independent of Autobot | PASS | **DATABASE VERIFIED** — 149 ticks all day regardless of kill-switch toggles |
| No automatic LIVE arming | PASS | No `LIVE` rows anywhere in Friday's `trades`; `execution_environment` values seen were only `PAPER`/`UNKNOWN`/`REPLAY` |
| Fill uniqueness (`orderId`, `cumulativeQuantity`) | Not re-exercised against Friday's specific fills this pass (only 2 real fills that day, no duplicates observed) | **DATABASE VERIFIED** (no duplicate fill rows found for Friday), migration-level uniqueness constraint not re-read this pass |
| `BROKER_ENVIRONMENT_UNKNOWN` fix (this session) | **Fixed and tested this session** — see §13 | **CODE VERIFIED** + **TEST VERIFIED** |

---

## 13. The `BROKER_ENVIRONMENT_UNKNOWN` Defect (Already Fixed This Session)

This audit's own Friday evidence (TSLA/RIOT manual-override rejections, §4/§5) is the *exact* incident
that a prior task in this same working session already root-caused and fixed, **before** this
read-only audit began. For completeness and honesty (per the audit's own "do not claim working
correctly without tracing the actual session" rule), it is documented here rather than omitted:

- **Root cause:** `OrderManagement.ts`'s `readTradingMode()` returned the raw `settings.tradingMode`
  DB value verbatim, including `null` on a missing/malformed row. `classifyBrokerEnvironment()` only
  accepts exactly `'PAPER'`/`'LIVE'` after uppercasing — anything else fails closed to `UNKNOWN`,
  rejecting the order, even though `resolveOmsPaperMode()`'s own `PAPER_TRADING_ONLY` short-circuit
  and Alpaca's `getCapabilities()` both say PAPER is fine.
- **Fix:** `readTradingMode()` now routes the value through the existing `normalizeTradingMode()`
  helper, which always resolves to a valid mode and defaults ambiguity to `PAPER`, never `LIVE`.
- **Verification:** a new regression test in `OrderManagement.test.ts` reproduces the exact TSLA
  scenario; 2 new tests in `brokerEnvironment.test.ts` document the still-correct fail-closed case vs.
  the now-fixed normalized case. Full write-up: `docs/audits/PAPER_TRADING_READINESS_VERDICT.md`.
- **Scope of impact, re-confirmed by this audit's own Friday data:** this defect only ever affected
  the 2 **manually-initiated** test trades (TSLA, RIOT) — it did **not** cause the organic zero-trade
  outcome, since zero organic ideas ever reached `CHIEF_APPROVED_IDEA` in the first place (§6). It is
  a real defect that was correctly found and fixed, but it is not the Friday session's primary story.

---

## 14. Test Results (RUN VERIFIED This Pass)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors**, exit 0 — run fresh this pass |
| `npm run build` | **Succeeds**, exit 0 — run fresh this pass (`dist/server.cjs` + `dist/server.cjs.map` produced) |
| `npx vitest run` (full suite) | **348 / 348 test files passed, 2,210 / 2,210 tests passed**, exit 0, 320.59s — run fresh this pass, not copied from an earlier pass in this session |

---

## 15. Runtime Evidence Summary

All Friday-session facts in this report are **DATABASE VERIFIED** direct SQL queries against
`data/argus.db` (not re-stated from any prior audit document), cross-checked against the DB's own
`MIN(ts)`/`MAX(ts)` range to catch exactly the kind of date-window bug this codebase's dual
timestamp-format convention invites (§2). Current `.env`/`settings` values were read directly, not
assumed from documentation.

---

## 16. Root Cause Tree

```
ZERO ORGANIC TRADES (Friday 2026-08-21)
│
├── PRIMARY ROOT CAUSE
│   └── ChiefTrader consensus never organically reached 0.75 confidence + 2 independent agents,
│       despite 4,521 ideas / 4,400 consensus cycles run that day (avg BUY confidence 0.179,
│       avg SELL confidence 0.267 — both far below the 0.75 bar)
│
├── CONTRIBUTING CAUSE
│   └── High AGENT_DISAGREEMENT rate (2,991 of ~4,400 cycles) — the min-2-independent-agent bar
│       was frequently not met even when one agent alone was confident
│
├── SECONDARY, REAL, ALREADY-FIXED DEFECT (does not explain the organic-zero outcome)
│   └── BROKER_ENVIRONMENT_UNKNOWN in OMS killed 2 of the day's 4 RiskEngine-approved orders —
│       but both were human manual-override test trades, not organic approvals (§13)
│
├── OBSERVATION, NOT A CAUSE OF ZERO TRADES
│   ├── A ~24-minute TRADING_PAUSED from a real $424.08 IBKR reconciliation mismatch — correct,
│   │   fail-closed behavior, and it occurred hours after the organic-approval question was
│   │   already moot (no organic idea had approached approval all day, before or after)
│   └── A 6-second manual EMERGENCY_STOP/resume toggle at 10:06 ET — a deliberate operator test
│
└── NOT CAUSES
    ├── RiskEngine (only ever saw 7 ideas total; evaluated all 24 gates correctly on each)
    ├── OMS (correctly gated the 2 manual-override trades it did reject; the defect there is real
    │       but irrelevant to the organic-zero outcome)
    ├── BrokerManager / Alpaca / IBKR connectivity (2 orders that did reach the broker filled cleanly)
    ├── Market hours (7/7 passed)
    ├── Autobot state (7/7 passed `autobot_enabled`; Autobot-off would not have blocked the day's
    │       one real SELL exit anyway)
    └── The Daily Goal Campaign target (advisory-only; correctly did not force any entry, §7)
```

---

## 17. Current Status Dashboard

| Area | Status |
|---|---|
| Architecture | GREEN |
| Code health | GREEN (`tsc --noEmit` clean, `npm run build` clean) |
| Tests | GREEN pending final full-suite count (§14 addendum) |
| Build | GREEN |
| Market data | GREEN (no `data_freshness` systemic failures Friday beyond 2 individually-stale-quote gate blocks) |
| Agents | GREEN (all documented agents actively producing predictions Friday) |
| Autobot | GREEN (on, gate passing, correctly not blocking the one real SELL exit) |
| Consensus | **YELLOW** — mechanically correct and fail-closed, but produced zero organic approvals all session; this is the day's real story, not a defect to "fix" by loosening it |
| Risk Engine | GREEN |
| OMS | YELLOW→GREEN (the `BROKER_ENVIRONMENT_UNKNOWN` defect was real; fixed and tested this session) |
| Broker integration | GREEN (both orders that reached the broker filled cleanly) |
| Reconciliation | GREEN (caught a real mismatch, paused correctly, never auto-resumed) |
| Paper trading | `PAPER_READY_WITH_REQUIRED_OPERATOR_ACTIONS` (unchanged) |
| Organic performance evidence | **NOT ESTABLISHED** (0 organic trades Friday; 0/30 · 0/10 soak floors still unmet) |
| LIVE readiness | `LIVE_NO_GO` (re-confirmed **RUN VERIFIED** this session) |

---

## 18. Critical Findings

1. **Consensus bottleneck is the whole story.** Not a bug — the gate is doing exactly what it's
   configured to do — but it means the paper-trading product, as configured, produced no organic
   signal all session. This is a research/edge question, not an engineering defect.
2. **`BROKER_ENVIRONMENT_UNKNOWN`** — real defect, already fixed and tested this session (§13).
3. **A 4,400-vs-360 gap between consensus cycles and persisted `consensus_decisions` rows** —
   disclosed as an instrumentation gap (§5), not explained away.
4. **A 6-event gap** between `ORDER_EXECUTED` (6) and real terminal `trades` rows (4) — disclosed,
   not explained away (§5).

## 19. What Is Working Correctly

RiskEngine's 24-gate ladder, OMS's idempotency and lifecycle events (once past the now-fixed
environment gate), PortfolioReconciliation's fail-closed pause/no-auto-resume behavior, the news veto,
the Daily Goal Campaign's advisory-only design, and the manual-override sandbox's own safety property
(bypasses ChiefTrader only, never RiskEngine/OMS) — all directly observed working as documented against
real Friday data, not merely asserted from prior docs.

## 20. What Is Broken or Unverified

- `BROKER_ENVIRONMENT_UNKNOWN` — broken on Friday, fixed this session (§13).
- The two instrumentation gaps in §5/§18 (items 3–4) — unverified, not broken per se, just unreconciled.
- Whether `QUANT_ENGINE_ENABLED` is still on today (it clearly was Friday) — not re-checked this pass.
- Duplicate-process/single-writer protection — not re-exercised live this pass.

## 21. Instrumentation Gaps

- `event_traces`/`observability_events` use epoch-ms integers while `trades`/`risk_assessments`/
  `consensus_decisions`/`agent_predictions` use ISO-8601 text — a standing cross-table trap (already
  documented in `CLAUDE.md`, re-encountered and caught in this very audit, §2).
- No table currently lets you cheaply reconcile "consensus cycles run" (4,400) against "consensus
  decisions persisted" (360) or "ORDER_EXECUTED fired" (6) against "real terminal trades rows" (4)
  without a deeper code trace than this read-only pass performed.

## 22. P0–P4 Action Plan

| Priority | Item | Evidence | Recommended action | Files | Risk | Tests required | Affects trading safety? |
|---|---|---|---|---|---|---|---|
| P0 | None — the one real P0 found in this window (`BROKER_ENVIRONMENT_UNKNOWN`) is already fixed and tested. Re-verify with a live `./argus.sh start`/`stop` cycle before next session (not yet done live, per `PAPER_TRADING_READINESS_VERDICT.md`). | §13 | Operator action, not code | — | — | — | — |
| P1 | Investigate why organic consensus confidence clusters so far below 0.75 (agent weighting? indicator quality? symbol selection?) — a research question, not a safety change | §6 | Analysis pass using `agent_performance_stats`/`agentWeights.json`, not a threshold change | `src/server/agents/ChiefTraderAgent.ts`, `config/agentWeights.json` | Low (read-only analysis) | N/A yet | No — do not lower the threshold to "fix" this |
| P1 | Reconcile the 4,400-vs-360 `consensus_decisions` persistence gap | §5, §18 | Read `ChiefTraderAgent.ts`'s decision-persistence condition | `src/server/agents/ChiefTraderAgent.ts` | Low | Add an assertion/test once understood | No |
| P2 | Reconcile the 6-vs-4 `ORDER_EXECUTED` count | §5, §18 | Read `OrderManagement.ts`'s every `emitOrderExecution` call site | `src/server/services/OrderManagement.ts` | Low | Add a test once understood | No |
| P3 | Live-verify duplicate-process/single-writer protection against the current build | §12 | A real second-process-open reproduction | — | Low (test-only) | New test | No |
| P4 | None identified this pass beyond the already-tracked Java Quant Core migration | — | — | — | — | — | — |

---

=========================================================
FINAL FORENSIC VERDICT
=========================================================

**CURRENT ARGUS STATUS:** Paper-ready with required operator actions; LIVE_NO_GO; engineering
health green (clean typecheck, clean build); one real P0 defect found and fixed this session.

**LAST FRIDAY SESSION:** Argus ran continuously and healthily all day on 2026-08-21 — market data
flowed, all documented agents produced thousands of predictions, and the RiskEngine/OMS/broker/
reconciliation stack all functioned correctly on the handful of ideas that reached them — but the
autonomous ChiefTrader consensus layer never once organically approved a trade idea, out of 4,521
generated and 4,400 consensus cycles run. The only 7 approved ideas all day were 6 human-initiated
manual-override test trades and 1 genuine autonomous risk-exit SELL that correctly banked a Daily-Goal-
Campaign target. A real software defect (`BROKER_ENVIRONMENT_UNKNOWN`) separately killed 2 of the
manual-override test trades at the OMS boundary; it has since been root-caused and fixed within this
same working session. A legitimate, fail-closed reconciliation pause (a real $424.08 IBKR mismatch)
also occurred and was handled exactly as designed.

**EXACT REASON ZERO ORGANIC TRADES OCCURRED:** Primary root cause — the ChiefTrader consensus bar
(0.75 confidence, 2 independent agreeing agents) was never organically cleared, despite an actively
running idea-generation pipeline (average observed BUY confidence 0.179, SELL confidence 0.267).
Contributing cause — a high agent-disagreement rate (2,991 of ~4,400 cycles). Not a cause — RiskEngine,
OMS, BrokerManager, market hours, or Autobot state, all of which functioned correctly on the small
number of ideas that ever reached them.

**DID ARGUS MALFUNCTION?** PARTIALLY — one real OMS defect existed and affected 2 manual test trades
(now fixed); the organic zero-trade outcome itself was not a malfunction.

**WAS TRADING CORRECTLY BLOCKED?** YES, for the consensus-layer outcome (the bar simply wasn't met);
YES, for the reconciliation-driven pause (fail-closed, exactly as designed).

**CURRENT PAPER READINESS:** CONDITIONALLY READY — mechanically sound, `BROKER_ENVIRONMENT_UNKNOWN`
fixed, but organic trading edge remains completely unestablished (0 organic trades to date).

**NEXT REQUIRED ACTION:** A supervised paper session with an operator watching reconciliation and the
now-fixed OMS gate, to obtain the first real organic (non-override) trade data point.

**LIVE STATUS:** LIVE_NO_GO — re-confirmed via `evaluateLiveReadiness()`/`organic_paper_soak_status.ts`
this session; not otherwise proven LIVE_READY by anything in this audit.
