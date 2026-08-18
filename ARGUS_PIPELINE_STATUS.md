# Argus Dual-Loop Pipeline Status

Companion to `ARGUS_CONSENSUS_RUNTIME_FORENSIC.md` (the read-only investigation). This document covers the follow-up work actually done: three targeted Phase 1 code fixes, a Phase 2 audit of `PortfolioMonitor` (no changes needed — it already does what was asked), and a Phase 3 integration-point identification (no new code — the hook already exists and is unused). The execution spine was not rewritten anywhere in this pass.

## Phase 1 — Unblock Loop 1 (fixes applied)

### 1. FundamentalAgent / MacroAgent resilience

The forensic report left the exact trigger of the 16-hour silent death **unresolved** but identified the one piece of state both agents actually share: `AlphaVantageBudget`'s module-level `chain` promise mutex (`src/server/services/AlphaVantageBudget.ts`). If a single enqueued operation there ever hangs (never resolves or rejects — a stuck cache read, a dangling call), every future `tryConsume()` from *either* agent queues behind it forever, with zero log output, because nothing ever throws. That failure signature — total silence, both agents, no crash-log entry — matches what was observed exactly.

**Fix:** `enqueue()` now races each operation against a hard timeout (`tradingSafety.alphaVantageBudgetLockTimeoutMs`, new config value, default 10s). A hang now degrades to a loud per-cycle error instead of permanent silent starvation — the shared lock always releases. Added a regression test (`AlphaVantageBudget.test.ts`) that simulates a permanently-hung dependency call and proves a later caller still resolves instead of hanging forever.

**Also added:** a `lastTickAt` heartbeat on both `FundamentalAnalysisAgent` and `MacroEconomyAgent`, set at the very top of every tick *before* any gate check, so it updates even when the tick is legitimately gated off. Exposed via `getPipelineAgentSnapshot()` (`GET /api/v1/system/pipeline-agents`) as `lastTickAt` / `lastTickAgeMs` per agent. This is the actual gap that let the 16-hour death go unnoticed: the existing snapshot only reported the *configured* `enabled` flag, which stayed `true` the whole time — there was no way to see the timer itself had died. A future recurrence is now visible within one polling cycle instead of requiring a DB forensic pass.

**Not done, and deliberately not attempted:** reproducing the exact original hang. That would require live debugging/instrumentation beyond what a static-analysis pass can respectfully claim, and the resilience fix protects against the *class* of failure regardless of its precise trigger.

### 2. Single-model debate over-weighting

Confirmed a real, separate bug while implementing this: `AIRouter.routeConsensus()`'s returned `results` array includes *both* successful and failed provider attempts. `ChiefTraderAgent.ts` was using `debateResult.results.length` for the "Based on N models" reasoning text — meaning a debate where every single provider timed out or errored still got reported and weighted as if it were a real N-model consensus (this is not hypothetical: one live trace, `kronos-1787084865940`, shows exactly this — 2 providers, both `status: error`, still recorded as a normal HOLD consensus evidence row at the full flat confidence).

**Fix (`AIRouter.ts` + `ChiefTraderAgent.ts`):**
- `routeConsensus()` now also returns `successCount` (the honest count of providers that actually returned a usable verdict). `results` itself is left unchanged — other tests and future telemetry consumers still need the raw per-provider outcome list including failures.
- `ChiefTraderAgent.ts`: if `successCount === 0`, the debate now goes through the existing fail-closed path (`pushDebateFailClosed`) instead of being reported as a normal result — zero real models is not a debate.
- If `successCount === 1`, the result is still used, but confidence is discounted by the new `tradingSafety.debateSingleModelConfidencePenalty` (0.7) and the reasoning text now says `"Single-Model Debate Concluded... confidence discounted, not treated as multi-model consensus"` instead of implying a real multi-model panel agreed.
- `successCount >= 2` keeps the original flat `debateResultConfidence` (0.8) and reasoning — unchanged behavior for a genuine multi-model result.

No threshold in the approval math (`consensusApprovalThreshold`, `minIndependentAgreeingAgents`) was touched — this only fixes how much weight a *single or zero-model* debate outcome is allowed to carry.

### 3. NewsAgent / FinBERT evidence flow — clarification, not a fix

Re-verified against live data: this is intentional desk policy, not a defect. `config/deskIntelligence.json.newsEmitsTradeIdeas: false` means NewsAgent's sentiment/FinBERT output does **not** flow into `ChiefTraderAgent`'s weighted vote as an idea — it flows into `RiskEngine`'s separate `news_veto` gate (gate #14) instead, and that path is confirmed alive (news clustering ingest is producing rows continuously). Turning `newsEmitsTradeIdeas` to `true` would be a real behavior change to what counts as a voting agent, which is exactly the kind of threshold/participation change the forensic report's §13 recommended reviewing deliberately rather than flipping as a side effect — it was **not** changed here.

### 4. Consensus quorum vs. available agents

Not changed, per explicit instruction. With fix #1 in place, FundamentalAgent/MacroAgent should resume producing real evidence going forward (their gates were never the blocker — the timer was). That restores up to 4 potential independent voices (Technical, Kronos, Fundamental, Macro) against `minIndependentAgreeingAgents=2`, without touching the threshold itself.

## Phase 2 — Loop 2 audit (`src/server/services/PortfolioMonitor.ts`)

No code changes made here — everything asked for already exists and is already tested.

- **Position tracking:** `reviewPortfolio()` runs on a 60s interval (`runtimeIntervals.portfolioMonitorMs`), with an in-flight guard (`isReviewing`) that skips overlapping ticks rather than letting two reviews race. Reads real open `portfolio` rows and real live prices from `MarketDataWorker.getLatestPrice()` — never fabricated.
- **Exit trigger logic**, in the order actually evaluated:
  1. If the position's opening trade carries a quant-strategy-specific stop/target (captured at entry), that governs first: `EXIT_CODE=TARGET_REACHED` / `EXIT_CODE=HARD_STOP`.
  2. If a stored thesis exists, `evaluateLiveThesis()` re-pulls real daily bars and re-runs the same regime/volume/structure classification the entry used, to check whether the original thesis is now invalidated (`EXIT_CODE=THESIS_INVALIDATION`) — genuinely re-computed, not a fabricated check.
  3. A generic trailing-stop backstop (`EXIT_CODE=TRAILING_STOP`) still applies underneath quant-specific stops.
  4. For any position without a quant stop/target/thesis, the generic settings-driven `takeProfitPct` / `trailingStopPct` thresholds apply directly.
  - **Terminology note:** `trailingStopPct` is a **fixed percentage from entry price**, not a peak-tracking trailing stop that ratchets up as price rises. The exit rule is real and enforced; the name just overstates what it mechanically does. Worth a documentation/rename cleanup, not a logic fix.
  - **Gap, not a bug:** there is no time-based (e.g. "flatten before close") exit rule anywhere in this file. If intraday/EOD liquidation is wanted for future short-horizon strategies, it doesn't exist yet and would be new logic, not a fix to something broken.
- **OMS routing:** every exit here is emitted as `eventBus.emitTradeIdea({..., agent: 'PortfolioManager', side: 'SELL'})`. `ChiefTraderAgent.reviewIdea()` recognizes `agent === 'PortfolioManager' && side === 'SELL'` as a risk-exit and skips the debate/quorum requirement (capital preservation is not a vote) but still calls `evaluateConsensus()` → RiskEngine's full 24-gate ladder (including `sell_position_exists`) → OMS → BrokerManager. **Confirmed: no direct broker call anywhere in this file.** The spine is intact for exits exactly as it is for entries.

## Phase 3 — Dynamic scanner integration point (identified, not built)

The exact hook already exists and is currently unused: `MarketDataWorker.subscribe(symbol: string)` / `.unsubscribe(symbol: string)` (`src/server/services/MarketDataWorker.ts:198-213`). It adds/removes from the worker's `activeStreams` set and, if the Alpaca socket is already open, sends a live `{action:"subscribe"}` message immediately; if the socket isn't open yet, the symbol is simply queued into `activeStreams` and picked up on the next connect/reconnect via `sendSubscribe()`. No changes to the WebSocket lifecycle, reconnect backoff, or default-symbol logic (`defaultSubscribeSymbols()`, driven by `config/markets.json`) would be needed.

A future dynamic scanner's integration is therefore: emit a discovery event (e.g. `WATCHLIST_EXPANDED`) and have one listener call `marketDataWorker.subscribe(symbol)` per new ticker. That listener does not exist yet — this section identifies where it plugs in, per the request; it was not built, consistent with the multi-asset/penny-stock work still being paused.

## Verification gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **Clean**, zero errors, after all changes in this pass |
| 24 RiskEngine gates unaltered | **Confirmed unaltered by this pass.** `git diff` on `RiskEngine.ts` shows one hunk, but it predates this session's work on the forensic/pipeline tasks — it's the already-existing (uncommitted, from earlier in this session, before the explicit pause instruction) `applySubordinateAssetNotionalCap()` hook from the paused multi-asset groundwork. It is fail-closed to a no-op (`ARGUS_PENNY_STOCK_ENABLED=false` right now, confirmed in `.env`), and even when enabled it can only ever *lower* (`Math.min`) a BUY's notional cap, never raise one or skip a gate. No gate was removed, reordered, or weakened. Flagging this explicitly rather than silently reporting a clean diff. |
| `PortfolioMonitor` active background loop | **Confirmed** — `setInterval` + in-flight guard, real DB/price reads, already covered by 10 existing passing tests |
| Core execution spine 100% intact | **Confirmed** — no new/changed caller of `placeOrder`/`BrokerManager`/OMS anywhere in this pass; `PortfolioMonitor` exits and `ChiefTraderAgent`'s debate handling both still route through the same RiskEngine → OMS → BrokerManager path |
| Full test suite (`npx vitest run`) | Ran in the background; targeted suites for every file touched this pass (ChiefTraderAgent, AIRouter, AlphaVantageBudget, FundamentalAgent, MacroAgent, pipeline-agents route, pipelineAgentGate) all pass — 63 tests, 0 failures. Full-repo run result to follow once it completes. |

## Files changed this pass

- `config/tradingSafety.json`, `src/server/config/tradingSafety.ts` — added `debateSingleModelConfidencePenalty`, `alphaVantageBudgetLockTimeoutMs`.
- `src/server/services/AlphaVantageBudget.ts` (+ `.test.ts`) — shared-lock timeout hardening.
- `src/server/services/FundamentalAgent.ts`, `src/server/services/MacroAgent.ts` — `lastTickAt` heartbeat.
- `src/server/core/pipelineAgentSnapshot.ts` — surfaces `lastTickAt` / `lastTickAgeMs`.
- `src/server/ai/AIRouter.ts` — `routeConsensus()` returns `successCount`.
- `src/server/services/ChiefTraderAgent.ts` — honest model-count-based debate confidence/fail-closed handling.
- `.env` — synced with `.env.example` (all existing real secrets preserved; missing non-secret flags added with their documented defaults).

No changes to `RiskEngine.ts`, `OrderManagement.ts`, `BrokerManager.ts`, `PortfolioMonitor.ts`, or `MarketDataWorker.ts` in this pass.
