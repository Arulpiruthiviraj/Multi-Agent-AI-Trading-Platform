# ARGUS Pre-Market Readiness Certification
**Audit date:** Sunday 2026-10-04 (market closed)
**Certified tip:** `40581f0` — "quant: harden bestStrategyIdea() - require triggerMet explicitly", branch `main`, tree clean
**Session stance:** PAPER TRADING ONLY · LIVE_NO_GO

**Verification provenance.** Defect tests A, B, D, F, G, H, J were executed at `c0fa6db` and carry over: the delta `c0fa6db..40581f0` touches only `OrderManagement.ts`, `OrderManagement.test.ts`, `tradingSafety.{json,ts}`, `StrategyEngine.ts`, `triggerGate.test.ts` — none of those defects' code paths. Defect E, kill-switch tests, trigger-gate items, and the full build/test pass were executed **at** `40581f0`.

**Hard rules for this document.** PAPER TRADING ONLY, LIVE_NO_GO. This report does not claim Argus "will make money tomorrow"; no audit can prove that. Every number below is verified; where something is unverified it is stated as such. Java is UNVERIFIED_ON_THIS_HOST (no JDK: `which java mvn javac` empty). The full `sim:market-open --certify` was **NOT** run (requires the real `ENCRYPTION_SECRET`, which this environment lacks; it spawns the real pipeline). Unit-level synthetic tests are not the full certify run and are not presented as such.

---

## CURRENT COMMIT

- Tip: `40581f0` on `main`. HEAD message: "quant: harden bestStrategyIdea() - require triggerMet explicitly".
- The only new behavior at this tip vs `c0fa6db` is the `bestStrategyIdea()` defense-in-depth hardening (requires `triggerMet===true` AND `confidence >= 0.6`) plus the `triggerMet` field fixture updates and `tradingSafety.{json,ts}` / `triggerGate.test.ts` changes from `6688f40`.
- This tip is where the trigger-gate suite (29/29), OMS price-deviation tests (4 new), and kill-switch tests were executed.

## WORKING TREE STATUS

- Tree clean at `40581f0`. No uncommitted changes, no stash, no detached HEAD.
- `ENCRYPTION_SECRET` during test execution was a throwaway per-process test secret, never written to disk. Without it, most suites cannot even import (documented limitation, not a defect).

## KNOWN DEFECT STATUS

| ID | Defect | Verdict | Evidence |
|----|--------|---------|----------|
| A | Stale broker state can resurrect sold shares / CLOSE_LONG can create short | **FIXED** | `positionFillEvidence.ts`: `POSITION_FILL_CONFLICT` on broker-vs-watermark disagreement; `CLOSE_LONG_QUANTITY_EXCEEDED`; persisted PENDING reservation refuses second exit trace. 8/8 positionEvidence tests pass, including the exact OKTA replay (BUY14 → SELL14 FILLED → stale +14 → second SELL REJECTED, `placeOrder` never called). "Production SELL means CLOSE_LONG. OPEN_SHORT has no authorized production order path." |
| B | Realized P&L wrong on SELL fills | **FIXED** | `applyPositionFill` accrues realized P&L only on the closing portion; an opening-short SELL gets `profit_loss = NULL`. 2/2 property tests (300-run fast-check: cumulative SELL fills never exceed BUY fills; position never negative). |
| C | Kill-switch race allows broker submission | **FIXED** | `OrderManagement.ts` (~line 615) re-checks `tradingState !== 'TRADING_ENABLED'` immediately before the sole `placeOrder` call, with no `await` between check and submission → `KILL_SWITCH_ENGAGED_AT_SUBMIT`. 29/29 OMS tests. |
| D | STOP order type silently becomes MARKET | **FIXED** | `IBGatewaySocketAdapter.placeOrder` (line 252) throws for non-(MARKET\|LIMIT\|STOP\|STOP_LIMIT); STOP→STP, STOP_LIMIT→STOP_LIMIT mapping; unknown types refused, never defaulted to MARKET. 30/30. |
| E | LIMIT order submitted against stale quote (NEW at this tip, from `6688f40`) | **FIXED** | OMS final-submit boundary: LIMIT checked vs freshest `MarketDataWorker` quote; no quote → `PRICE_DEVIATION_NO_QUOTE_AVAILABLE` (fail-closed); deviation > `maxPriceDeviationPct` 0.02 (`config/tradingSafety.json`, documented conservative default) → `PRICE_DEVIATION_EXCEEDED`. MARKET orders never blocked (deviation only logged). 4 new tests pass at tip. |
| F | Frozen daily bar used as live current price | **FIXED** | `provisional` column on `ohlcv_bars`; today's bar refreshable until session close; `resolveQuantCurrentPrice` prefers the live tick. 9/9. |
| G | Market-hours handling not fail-closed | **FIXED** | Market-hours gate falls back to `classifyMarketSession` when Alpaca unconfigured; never OPEN when unconfigured. 19/19, including a test on a real weekend. |
| H | Mid-position restart / crash recovery duplicates or loses position | **FIXED** | `restartMidPosition` 1/1 + `crashRecovery` 9/9: position survives simulated state loss, reconciliation recovers without duplication, subsequent SELL flattens with P&L. |
| I | DB/query path can hang or lock under load | **UNKNOWN** (low-risk by inspection) | Bounded LIMIT-100 `better-sqlite3` read, no locks; 20s CLI fetch timeout. Cannot be fully proven under live load without running the engine; `/orders` hang behavior assessed statically only. |
| J | Watchdog can trade or corrupt state during restart | **FIXED** | `argusWatchdog.ts` runs as an external process; state machine NONE → LOG_SUSPECT → RESTART → FORCE_KILL_AND_RESTART → ALERT_HALTED → RESUMED_HEALTHY; max 3 restarts/hour → ALERT_HALTED. It never calls trading/resume endpoints (engine boots to TRADING_PAUSED; resume is operator-only) and never opens `argus.db`. 10/10. |
| Trigger-gate | Triggerless high-confidence strategy ideas could drive consensus | **FIXED** | `StrategyEvaluation.triggerMet` required (`types.ts:58`); `applyTriggerGate` caps confidence at `triggerAbsentConfidenceCap` 0.4 + records contradiction, wired into `StrategyEngine.evaluateAll` (line 139), `BacktestEngine` (line 630), `argusStrategyReplay` (line 137). `bestStrategyIdea()` defense-in-depth at `40581f0` requires `triggerMet===true` AND `confidence >= 0.6` (`StrategyEngine.ts:194-201`). Runtime-verified at tip: direct `bestStrategyIdea(triggerMet=false, conf=0.99, score=99)` → `null`; triggerless-95 vs genuine-70 → genuine wins. 29/29 tests. All 21 TS strategies declare `triggerMet`. `VWAPContext.intradayBased` required; 5 VWAP strategies gate on it; degenerate daily-bar VWAP rejected. One non-emission bypass exists: `strategyParityHarness.ts:125` — research golden-file harness only, informational (see REMAINING DEFECTS). Java re-port source-mirrors `triggerMet` (`StrategyEvaluation.java:16`; `StrategyParityTest.java` asserts) but is UNVERIFIED_ON_THIS_HOST. |

All P0 (execution-critical) defects verified FIXED with passing regression tests. Defect I is the only non-FIXED item and is a low-risk inspection-only assessment, not an execution-critical defect.

## THURSDAY/FRIDAY INCIDENT STATUS

- **OKTA −14 (Friday).** STILL_PRESENT per last documented state (`docs/audits/ARGUS_CURRENT_DEFECT_STATUS_AND_REMEDIATION_2026-10-04.md` §A; `ARGUS_ARCHITECTURE.md` §2026-10-03): no fill-ledger watermark was in place at the time; Friday's broker and Argus snapshots both showed **−14** @ **$212.5341857** cost basis; unrealized P&L **UNKNOWN**. The mechanism is now understood and regression-guarded (defect A, 8/8 tests), but the incident itself still requires a reviewed broker reconciliation plus `RECONCILE_BASELINE` recovery (`config/allowedOperations.json`: `scripts/reconcile_broker_baseline.ts`) **before** any supervised PAPER session — this is a hard pre-market gate (see Q9, Q10, PRE-MARKET CHECKLIST).
- No other Thursday/Friday incidents are open. The `strategySelectionReplay` fairness-replay evidence is red at tip for a test-debt reason only (fixtures predate `triggerMet`), not a production defect — see REMAINING DEFECTS (2).

## POSITION SAFETY

- Production SELL means CLOSE_LONG. OPEN_SHORT has no authorized production order path (defect A remediation).
- `CLOSE_LONG_QUANTITY_EXCEEDED` refuses exits beyond the watermarked fill-ledger position; a persisted PENDING reservation refuses a second exit trace.
- `sell_position_exists` risk gate blocks SELL when no position exists.
- The exact OKTA replay (BUY14 → SELL14 FILLED → stale +14 → second SELL REJECTED, `placeOrder` never called) passes. 8/8 positionEvidence tests.
- Realized P&L accrues only on the closing portion of a fill; opening-short SELL gets `profit_loss = NULL` (defect B). 300-run adversarial property tests pass.
- **Caveat:** position truth is UNVERIFIABLE tonight (engine down; no `data/argus.db` on this machine). All of the above is code+test evidence, not live-state evidence.

## BROKER SAFETY

- Paper/LIVE isolation is **proven in code**: `PAPER_TRADING_ONLY=true` demotes LIVE→PAPER (`tradingModeEnv.ts:12-43`); `authorizeProductionOrder` is a 5-layer LIVE arming check (`liveOrderAuthorization.ts:26-57`); dual-flag UNKNOWN→block (`brokerEnvironment.ts:17-46`); `BrokerManager.setLiveMode(true)` throws when `PAPER_TRADING_ONLY=true`; paper prefixes DU/DF are checked before live U/F/I (`ibkrAccountClassification.ts:20-68`); preferred account `DUR959160` resolves to PAPER; `ARGUS_LIVE_READINESS.json` reads **LIVE_NO_GO** (6/28 gates).
- **CAVEAT:** this checkout has no `.env` and the shell lacks `PAPER_TRADING_ONLY`. It **MUST** be asserted in the deployment environment before boot Monday (pre-market checklist gate).
- OMS submission safety: traceId idempotency (select-check + unique index; failed check aborts); PENDING-before-submit; clientOrderId passed through; `SUBMIT_UNKNOWN` → PENDING + trading paused + `reconcileStaleOrders` (never blind retry); restart reconciliation sits behind the crash-recovery guard; fill ledger keyed on `(order_id, cumulative_quantity)`, duplicates are unique-constraint no-ops; commissions persisted as `undefined` (not 0) until IBKR reports them.
- Kill-switch race closed at the final-submit boundary (defect C): re-check of `tradingState !== 'TRADING_ENABLED'` immediately before the sole `placeOrder`, no `await` between → `KILL_SWITCH_ENGAGED_AT_SUBMIT`.

## KILL-SWITCH SAFETY

- Emergency stop races are closed: defect C re-check at the final submit boundary, 29/29 OMS tests including the kill-switch race tests at tip `40581f0`.
- Watchdog (defect J) never calls trading/resume endpoints; engine boots to TRADING_PAUSED; resume is operator-only. Max 3 restarts/hour → ALERT_HALTED. 10/10 tests.
- Runtime probes today: watchdog `running:false` = correct resting state with engine down. All CLI probes failed fast with ENGINE_UNREACHABLE (no hangs; no state touched).

## MARKET DATA

- Primary: Alpaca IEX WebSocket; IBKR capped at 90 lines. The delayed-data research feed is OFF by default and structurally isolated from RiskEngine price inputs (its own regression test).
- Freshness is fail-closed: null age ≠ fresh. Defect F closed the frozen-daily-bar path (provisional bars refreshed until session close; `resolveQuantCurrentPrice` prefers the live tick). 9/9.
- Market-hours classification is fail-closed in production PAPER: unconfigured clock falls back to the real NY session classifier, never OPEN; tested on a real weekend (defect G, 19/19).
- **2026-09-29 diagnostic (still standing):** this account's fee-waived real-time entitlement does **NOT** reach the IB Gateway API (code 10089); delayed fallback works. This is account-side, not an Argus defect — but it means Monday's session cannot assume live IBKR real-time ticks where entitlement is absent.
- **Tonight:** socket/subscription/freshness state is UNVERIFIABLE (MARKET_CLOSED, engine down). Monday requires fresh-tick **evidence**, not socket state — see Q14 and checklist.

## AGENT HEALTH

- `config/pipelineAgents.json`: togglable idea agents (Technical, News, Fundamental, Macro, Kronos + env-gated Quant, TradePlan, JavaFactorComposite, JavaCoreEnsemble — all default `false` in `.env.example`); always-on: ChiefTrader, RiskEngine, OMS, PortfolioMonitor, MarketData.
- Config toggles verified: no auto-enable; disabled stays disabled (toggles persist).
- **Health is UNVERIFIABLE with the engine down.** Agent health must be confirmed at boot Monday (Q15, checklist).
- RiskEngine gate coverage: 25 ordered gates, all fail-closed on missing/null/NaN/Infinity/stale (see RISKENGINE). 101/101 core + 19/19 gate tests.

## CONSENSUS

- Threshold **0.75** (`config/tradingSafety.json`; strict `>` required — `ChiefTraderAgent.ts:78,81`), `minIndependentAgreeingAgents: 2`, structural independence (Quant + JavaCoreEnsemble count once), hard vetoes (debate/bear HOLD, AI contradiction → NO TRADE), 60s vote TTL, `disagreementPenalty` 0.5 (e.g., Technical 30m vs Kronos 5m disagreement drags confidence → NO TRADE; no horizon-compatibility gate in consensus itself — intentional and documented), MODERATE tier env-gated default-off, QUANT_INDEPENDENT operator override only at a strictly-higher bar.
- The threshold was **NOT lowered**. Verified decision ladder: 2+ independent evidence groups + confidence > 0.75 (strict) + no veto → approval (code-verified).
- Weak evidence correctly yields NO TRADE: disagreement penalty, hard vetoes, 60s vote TTL, trigger-gate confidence cap (0.4 without `triggerMet`) all push weak/conflicting/absent evidence below the 0.75 bar. NO TRADE is a valid, successful outcome (see §29).

## RISKENGINE

- 25 ordered gates from `config/riskGateOrder.json`: `emergency_stop`, `autobot_enabled`, `same_symbol_cooldown`, `post_loss_cooldown`, `daily_trade_limit`, `duplicate_signal`, `invalid_account_equity`, `daily_loss`, `consecutive_loss`, `portfolio_drawdown`, `order_rate_limit`, `market_hours`, `data_freshness`, `news_veto`, `price_validity`, `order_notional_cap`, `symbol_concentration`, `open_positions_cap`, `sector_concentration`, `correlation_exposure`, `sufficient_size`, `sell_position_exists`, `argus_capital_allocation`, `daily_buy_notional`, `extended_hours_execution_policy`.
- All gates fail-closed on missing/null/NaN/Infinity/stale (`isPositiveFiniteMoney`; `INVALID_ARGUS_BUDGET`; `CAPITAL_SNAPSHOT_DEGRADED`; `RECONCILIATION_REQUIRED` on non-finite fills).
- 101/101 core + 19/19 gate tests pass at tip.
- New at this tip: LIMIT orders additionally pass the OMS price-deviation final-submit boundary (defect E): freshest `MarketDataWorker` quote required (`PRICE_DEVIATION_NO_QUOTE_AVAILABLE` fail-closed); deviation > `maxPriceDeviationPct` 0.02 → `PRICE_DEVIATION_EXCEEDED`. MARKET orders are never blocked (deviation logged only).

## OMS

- 29/29 OrderManagement tests at tip, including kill-switch race and 4 new price-deviation tests. Full OMS-related surface: 74 passed / 1 failed across 9 OrderManagement* files — the single failure is a 5s vitest-timeout flake in the reentrancy test; the invariant it tests was verified intact.
- Submission safety: traceId idempotency (select-check + unique index), PENDING-before-submit, clientOrderId passthrough, `SUBMIT_UNKNOWN` → PENDING + pause + reconcile (never blind retry), restart reconciliation behind crash-recovery guard, fill-ledger dedupe on `(order_id, cumulative_quantity)`, commissions `undefined` until IBKR reports.
- Order-type safety (defect D): unsupported types throw locally at `IBGatewaySocketAdapter.placeOrder:252`; STOP→STP / STOP_LIMIT→STOP_LIMIT; OMS only constructs MARKET/LIMIT; 30/30 tests.

## POSITION / ORDER RECONCILIATION

- **Positions reconciled? NO** — not verifiable tonight (engine down; deployment DB not on this machine). OKTA −14 is documented as still requiring a reviewed reconciliation. **MUST be verified Monday pre-market. HARD GATE.**
- **Orders reconciled? NO** — same reason. **MUST be verified Monday pre-market. HARD GATE.**
- Recovery tooling exists: reviewed broker reconciliation + `RECONCILE_BASELINE` (`config/allowedOperations.json`: `scripts/reconcile_broker_baseline.ts`).
- The code path is regression-guarded (defect A 8/8, defect H 9/9+1/1), but code evidence is not a substitute for live-state reconciliation on the deployment DB.

## CONFIGURATION

- **Budget — MISMATCH (Q13 = NO).** `$2,000` `paperAllocationProfile` was never activated; the runtime ran at `$100,000` with a `$3,000` max order notional. This must be decided and activated pre-session, and `settings.budget` / `maxTradeSize` / caps reconciled — a hard pre-market gate.
- `PAPER_TRADING_ONLY=true` is proven effective in code but this checkout has no `.env` and the shell lacks it — must be asserted in the deployment env before boot Monday.
- Agent toggles verified (no auto-enable; disabled stays disabled); Java agents are env-gated.
- Consensus threshold 0.75 intact; `maxPriceDeviationPct` 0.02 documented conservative default; `triggerAbsentConfidenceCap` 0.4.
- `ARGUS_LIVE_READINESS.json` = LIVE_NO_GO (6/28 gates).

## BACKTEST CORRECTNESS

Per-engine classification (self-declared where stated):

| Engine | Mode | Verdict |
|--------|------|---------|
| TS `BacktestEngine.run` + `runStrategyBacktest` | SAME_BAR_CLOSE | Self-declared; **quarantined** |
| TS `canonicalNextBarEngine.applyNextBarLongFills` | NEXT_BAR_CORRECT | Signal T → fill T+1 open, spread+slippage, honest gap-through on exits |
| Java `SignalDrivenBacktest` + `RsiThresholdStrategy` | SAME_BAR_CLOSE | Self-declared, non-promotable |
| Python `core_strategies.next_bar_open_stats` | NEXT_BAR_CORRECT | Fill at bars[i+1].open; costs from `researchSafety.json`; causal masks |
| Crypto `btcEthBacktestHarness` | NEXT_BAR_CORRECT | — |
| TS `WalkForwardValidator` | SAME_BAR_CLOSE | Self-declared, `promotable:false` |

**Quarantine: NO GAPS.** Every same-bar result found is marked NON_PROMOTABLE / INVALID_FOR_EDGE_CLAIM: all 15 `BASELINE_RESULTS.json` entries carry `promotable:false` + `SAME_BAR_CLOSE_NOT_PROMOTABLE`; quarantine block in `WALKFORWARD_CHECK_RESULTS.json`; `ENGINE_MISMATCH` guard; `stampSameBarPromotionQuarantine` on every read path (Q21 = YES).

## WALK-FORWARD / OOS EVIDENCE

Methodology per engine:

| Check | TS canonical | Python |
|-------|--------------|--------|
| Train/val/test separation | ENFORCED | ENFORCED (train/val/test) — `WalkForwardValidator` is train/test only |
| Purge / embargo | PARTIAL (5-bar val→test embargo; train→val contiguous; no cross-fold purge) | PARTIAL |
| Test not reused for selection | ENFORCED (nothing optimized) | NOT_ENFORCED (pooled test PnLs gate promotion — test reused for selection) |
| `minOosTrades` (30) | ENFORCED | NOT_ENFORCED (read but never used) |
| Multiple-testing correction as gate | NOT_ENFORCED | ENFORCED (DSR ≥ 0.95 promotion gate, `config/researchSafety.json`) |
| Validation slice used in selection | NOT_ENFORCED (computed, never read) | NOT_ENFORCED (computed, never read) |
| Parameter IDs | — | NOT_ENFORCED (`"{sid}:ANY"` + `INSERT OR REPLACE` overwrites) |

**Canonical WFO gauntlet (25 runs = 5 symbols × 5 strategies, GREEN real-market data, 21 folds):** every run FRAGILE with **0 trades in every test fold** — no metrics computable. This is the largest research uncertainty (below).

**Best in-sample perturbation runs** (next-bar, adversarial — corrected next-bar, realistic costs: commission $0.005/share, spread 2bps, slippage 5bps, qty 1):
- PULLBACK_CONTINUATION/QQQ: 36 trades, +$140.14 (~$3.89/trade), perm p 0.139 FAIL, ruin 0.032
- PULLBACK_CONTINUATION/AMD: 57 trades, +$175.46 (~$3.08/trade), perm p 0.219 FAIL, ruin 0.102
- PULLBACK_CONTINUATION/AAPL: 57 trades, +$7.57 (~$0.13/trade), perm p 0.423 FAIL, ruin 0.474
- RANGE_REVERSION/AMD: 153 trades, +$8.98 (~$0.06/trade), perm p 0.463 FAIL, ruin 0.514; entry-delay → −$105

All others FAILED or INSUFFICIENT_SAMPLE.

**Baseline campaign:** PULLBACK_CONTINUATION `backtestPass`✓ / `oosPass`✓ but `walkForwardPass`✗ / `permutationPass`✗ / `monteCarloPass`✗; RANGE_REVERSION `oosPass`✗; the rest fail all.

`ARGUS_READINESS_MATRIX.json`: validated 0, oosValidated 0, wfoValidated 0, robustnessValidated 0, paperValidated 0.

**Python WFO on real data: NOT RUN** (no data/research in tree); a fixture-only run verified mechanics (skips upserts on non-GREEN data).

**No new strategies silently added:** registry = 5 core + 16 experimental = 21; no squeeze/RSI-2/pairs IDs; Java `StatArbEngine` idle, `statArb:null` not wired.

## STRATEGY EDGE

- MOMENTUM_BREAKOUT: **NO_EDGE**
- PULLBACK_CONTINUATION: **PROMISING_BUT_UNPROVEN** — the only positive corrected-economics set, but in-sample, permutation fails everywhere, WFO yields zero test trades, ~$0–4/trade
- MEAN_REVERSION: **NO_EDGE**
- TREND_FOLLOWING: **NO_EDGE**
- RANGE_REVERSION: **NO_EDGE**
- 16 experimental: **INSUFFICIENT_SAMPLE** (no corrected results exist)
- **Bottom line: INSUFFICIENT_EVIDENCE for positive EV** under realistic execution.
- **Largest research uncertainty:** the canonical next-bar replay yields zero qualifying trades in every WFO test window. It is unknowable from tonight's evidence whether the strategies are signal-free or the replay confidence/threshold stack is miscalibrated relative to live. No corrected OOS expectancy is computable until this is resolved.

## SYNTHETIC CERTIFICATION

- Unit-level synthetic certification tests at tip `40581f0`: **77/77 PASS** across 8 files — TimelineInvariants (RISK_BYPASS, PHANTOM_FILL, CONSENSUS_BYPASS, ORDER_DURING_OUTAGE, UNLINKED_ORDER), CertificationGate, determinism, MarketClock, SimulationSafety.
- Golden critical scenarios: **336/336 PASS** (12 files).
- Architecture protection (7 boundary files): **64/64 PASS**.
- **The full `sim:market-open --certify` was NOT run** (requires the real `ENCRYPTION_SECRET`, which this environment lacks; it spawns the real pipeline). Unit-level synthetic tests are not the full certify run and must not be presented as such.

## PROPERTY TESTING

- Position/Fill invariants: 31 passed / 1 failed across 4 files — the single failure is a 5s vitest-timeout flake in `positionFillEvidence.property.test.ts`; invariants intact. Note: this test needs `--testTimeout` > 5s (default vitest 5s fails; it needs ~13–18s; no `testTimeout` configured in `vitest.config.ts`).
- P&L invariants (defect B): 2/2 property tests, 300-run fast-check (cumulative SELL fills never exceed BUY fills; position never negative).
- OMS reentrancy property test: 1 flake under the 5s default timeout; invariant verified intact.

## TEST RESULTS

(Tip `40581f0`; `ENCRYPTION_SECRET` was a throwaway per-process test secret, never written to disk; without it most suites cannot even import.)

| Suite | Result |
|-------|--------|
| `tsc --noEmit` | 0 errors — **PASS** (~82s) |
| Tier-1 (vitest excl. testing/slow) | 627 files (620 pass / 7 fail); 4870 passed / 7 failed / 0 skipped (~21 min) |
| Architecture protection (7 boundary files) | 64/64 **PASS** |
| Brokers (`src/brokers`, 34 files) | 311 passed / 3 failed |
| RiskEngine core (6 files) | 101/101 **PASS** |
| OMS (9 OrderManagement* files) | 74 passed / 1 failed (5s-timeout flake) |
| Reconciliation (11 files) | 43/43 **PASS** |
| Synthetic cert unit tests (TimelineInvariants incl. RISK_BYPASS/PHANTOM_FILL/CONSENSUS_BYPASS/ORDER_DURING_OUTAGE/UNLINKED_ORDER, CertificationGate, determinism, MarketClock, SimulationSafety — 8 files) | 77/77 **PASS** |
| Property/invariant tests (4 files) | 31 passed / 1 failed (5s-timeout flake; invariants intact) |
| `triggerGate.test.ts` | 29/29 **PASS** |
| Python (13 files: argus_research 11, scripts/lib 16, local_ai_service_validation 24, langgraph-research 58) | 109/109 **PASS** |
| Production build (vite + esbuild) | **PASS** (26.5s; dist/server.cjs 3.1 MB) |
| Golden critical scenarios (12 files) | 336/336 **PASS** |
| NOT RUN | full `sim:market-open --certify` (needs real `ENCRYPTION_SECRET`; spawns real pipeline); tier-3/tier-4 slow suites; Java/quant-core-java + TS/Java parity (no toolchain — UNVERIFIED_ON_THIS_HOST) |

**The 7 tier-1 failures:**
1. `BrokerManager.recovery.test.ts` boot-auth test — **GENUINE regression** from commit `6d0a9ce` (ALPACA_EXECUTION_ENABLED gate; test no longer covers the boot-safety behavior; proven via worktree bisect: 9/9 pass at `61df85e` → fail at tip). P2 test debt.
2. `strategySelectionReplay.test.ts` SELECTED_NEVER_EMITTED — **GENUINE regression** from `40581f0` triggerMet hardening (seeded fixtures predate the `triggerMet` field; predictedWinner 30→0). The fairness-replay evidence is red until fixtures are updated. P2 fixture debt.
3. `BrokerManager.test.ts` alpaca-switch — env-gated (same `6d0a9ce` gate; test assumes Alpaca execution in test env).
4. `urlSafety.test.ts` Slack-host — sandbox DNS sinkhole artifact (VM resolver returns 198.18.16.33 for all hosts; SSRF guard correctly fails closed).
5. `webhooks.test.ts` — same sandbox DNS sinkhole artifact.
6. `OrderManagement.reentrancy.test.ts` — 5s vitest-timeout flake; invariant intact.
7. `positionFillEvidence.property.test.ts` — 5s vitest-timeout flake; needs ~13–18s; invariants intact.

None of the 7 is an execution-critical production defect; (1) and (2) are P2 test/fixture debt to fix.

## REMAINING DEFECTS (P2 / non-safety)

1. Tier-1 failure #1: broker boot-recovery test broken by `6d0a9ce` env gate — test debt.
2. Tier-1 failure #2: `strategySelectionReplay` fixtures predate `triggerMet` — fairness-replay evidence red until fixtures updated.
3. `positionFillEvidence.property.test.ts` needs a configured `testTimeout` (default 5s fails).
4. Java `triggerMet` re-port UNVERIFIED_ON_THIS_HOST (source-mirrored only).
5. `/orders` hang behavior assessed statically only.
6. Python WFO methodology gaps (minOosTrades, dead validation slice, param-ID overwrite, test-reuse-for-selection).
7. `strategyParityHarness.ts:125` bypasses `applyTriggerGate` (research-only harness, informational — does not emit production signals).

## REMAINING UNCERTAINTIES

- OKTA −14 current broker truth (only resolvable Monday with the deployment DB).
- Deployment-environment `PAPER_TRADING_ONLY=true` assertion.
- Monday feed health (including the IBKR real-time entitlement gap, code 10089).
- Agent health at boot.
- Whether the WFO zero-trade outcome is signal-free strategies or a miscalibrated replay confidence/threshold stack.
- No corrected OOS expectancy is computable.

## PRE-MARKET CHECKLIST

Operator checkboxes for Monday morning. Items marked **[HARD GATE]** must pass or the session must not proceed.

- [ ] Engine healthy
- [ ] Watchdog healthy (external process; engine boots to TRADING_PAUSED)
- [ ] PAPER account confirmed (DUR959160; DU/DF prefix classification)
- [ ] LIVE_NO_GO confirmed (`ARGUS_LIVE_READINESS.json`)
- [ ] IBKR authenticated
- [ ] Market data LIVE where entitled — fresh-tick **evidence**, not socket state (note: fee-waived real-time entitlement does NOT reach IB Gateway API, code 10089 — plan accordingly)
- [ ] **[HARD GATE]** Positions reconciled — reviewed broker reconciliation + `RECONCILE_BASELINE` recovery (`scripts/reconcile_broker_baseline.ts`); OKTA −14 resolved with reviewed reconciliation
- [ ] **[HARD GATE]** Orders reconciled — no stale/unknown broker orders
- [ ] No P0/P1 blocker open
- [ ] **[HARD GATE]** Budget correct — decide $2,000 vs $100,000; activate the chosen `paperAllocationProfile` per its prerequisites; reconcile `settings.budget` / `maxTradeSize` / caps everywhere
- [ ] Agents healthy (ChiefTrader, RiskEngine, OMS, PortfolioMonitor, MarketData always-on; idea agents per toggles — no auto-enable)
- [ ] Java healthy, if enabled (env-gated; Java agents default off)
- [ ] Quant pipeline healthy
- [ ] Consensus functioning — threshold 0.75 intact (strict), minIndependentAgreeingAgents 2, 60s vote TTL active
- [ ] RiskEngine healthy — 25 gates armed, all fail-closed
- [ ] OMS healthy — kill-switch re-check at submit boundary; idempotency armed
- [ ] No stale market data (freshness fail-closed verified live)
- [ ] No unresolved reconciliation
- [ ] No unknown broker orders
- [ ] Deployment-env `PAPER_TRADING_ONLY=true` asserted before boot

## READINESS VERDICT

**READY_WITH_CONDITIONS.**

The code is signed: all execution-critical defects are verified FIXED with passing regression tests; RiskEngine 101/101 + 19/19; OMS 29/29; synthetic cert 77/77; golden 336/336; build green; LIVE_NO_GO isolation proven in code. The session cannot be signed until Monday's checklist gates pass — positions/orders reconciliation (OKTA −14 reviewed reconciliation + baseline recovery), budget activation decision, deployment-env `PAPER_TRADING_ONLY=true` assertion, fresh-tick feed evidence, and agent health at boot. If any hard gate fails, the session must not proceed.

## EDGE-EVIDENCE VERDICT

**WEAK.**

All 15 same-bar results are quarantined non-promotable; the only positive corrected-economics numbers are in-sample with failed permutation tests; the canonical next-bar WFO gauntlet (25 runs, GREEN real-market data, 21 folds) produced zero trades in every test fold — no corrected OOS expectancy is computable. `ARGUS_READINESS_MATRIX.json` reads zero validated on every axis. PULLBACK_CONTINUATION is PROMISING_BUT_UNPROVEN; everything else is NO_EDGE or INSUFFICIENT_SAMPLE.

## EXPECTED-EDGE STATUS (§28)

**INSUFFICIENT_EVIDENCE.** Cannot compute a corrected OOS expectancy: zero qualifying test trades in 25 canonical WFO runs; the only positive corrected numbers are in-sample with failed permutation tests; the readiness matrix reads zero validated on every axis. This is not a claim of zero edge — it is a statement that the evidence required to claim positive expected value under realistic execution does not exist tonight.

## §29 — CAN A FULLY HEALTHY ARGUS MAKE ZERO TRADES TOMORROW?

**YES.** Consensus 0.75 (strict) + disagreement penalty + trigger-gate + 60s vote TTL mean weak, conflicting, or absent evidence correctly yields NO TRADE. The decision ladder is code-verified: 2+ independent evidence groups, confidence > 0.75, no veto → approval; anything weaker is refused. NO TRADE is a valid, successful outcome.

## 25 YES/NO (§32)

1. Any known unresolved P0 defects? **NO** — all execution-critical defects verified FIXED with passing regression tests.
2. Any known unresolved P1 capable of changing orders/positions/prices/P&L? **NO** — kill-switch race, fat-finger P1-10, and trigger-gate all fixed and tested at tip.
3. Can CLOSE_LONG accidentally create a short? **NO** — POSITION_FILL_CONFLICT / CLOSE_LONG_QUANTITY_EXCEEDED / pending-reservation refuse; 8/8 replay tests pass.
4. Can stale broker state resurrect sold shares? **NO** — durable fill-ledger watermark; stale +14 snapshot rejected in exact OKTA replay.
5. Can an emergency stop race still allow broker submission? **NO** — KILL_SWITCH_ENGAGED_AT_SUBMIT re-check immediately before the sole placeOrder call, no await between.
6. Can STOP silently become MARKET? **NO** — unsupported types throw locally; STOP→STP / STOP_LIMIT→STOP_LIMIT mapping; OMS only constructs MARKET/LIMIT.
7. Can a frozen daily bar be used as a live current price? **NO** — provisional bars refreshed until session close; resolveQuantCurrentPrice prefers the live tick.
8. Is market-hours handling fail-closed in production PAPER? **YES** — unconfigured clock falls back to real NY session classifier, never OPEN; tested on a real weekend.
9. Are broker and Argus positions reconciled? **NO** — NOT verifiable tonight (engine down, deployment DB not on this machine); OKTA -14 documented as still requiring reviewed reconciliation. MUST be verified Monday pre-market.
10. Are broker and Argus orders reconciled? **NO** — same reason; MUST be verified Monday pre-market.
11. Is the OKTA incident permanently regression-tested? **YES** — 8/8 positionEvidence tests including the exact BUY14→SELL14→stale-+14 replay.
12. Is P&L independently validated? **YES** — realized P&L only on closing portion; opening-short SELL gets profit_loss=NULL; 300-run adversarial property tests pass (note: needs --testTimeout>5s; fails under vitest default 5s).
13. Is the selected trading budget consistent everywhere? **NO** — BUDGET_MISMATCH: $2,000 paperAllocationProfile never activated; runtime ran at $100,000 with $3,000 max order notional. Must be decided and activated pre-session.
14. Are all active market-data inputs fresh enough? **NO** — cannot confirm tonight (market closed, engine down); Monday requires fresh-tick evidence, not socket state.
15. Are all enabled agents healthy? **NO** — cannot confirm with engine down; config toggles verified (no auto-enable; disabled stays disabled); must confirm at boot Monday.
16. Can genuine strong evidence reach ChiefTrader approval? **YES** — 2+ independent evidence groups, confidence >0.75 (strict), no veto → approval (code-verified decision ladder).
17. Can weak evidence correctly produce NO TRADE? **YES** — disagreementPenalty 0.5, hard vetoes (debate/bear HOLD, AI contradiction), 60s vote TTL, threshold NOT lowered (0.75).
18. Does RiskEngine pass all certification tests? **YES** — 101/101 core, 19/19 gate tests; all 25 gates fail-closed on missing/null/NaN/Infinity/stale.
19. Does OMS pass all certification tests? **YES** — 29/29 OrderManagement incl. kill-switch race + 4 new price-deviation tests; traceId idempotency, PENDING-before-submit, no blind retry (one 5s-timeout flake in reentrancy test, invariant intact).
20. Does the full synthetic spine complete correctly? **NO** — full sim:market-open --certify NOT run (missing real ENCRYPTION_SECRET); unit-level synthetic/adversarial tests 77/77 green, golden 336/336 green.
21. Are same-bar-close results completely excluded from edge claims? **YES** — all 15 BASELINE_RESULTS.json entries carry promotable:false + SAME_BAR_CLOSE_NOT_PROMOTABLE; quarantine block in WALKFORWARD_CHECK_RESULTS.json; ENGINE_MISMATCH guard; stampSameBarPromotionQuarantine on every read path.
22. Are walk-forward/OOS methods statistically defensible? **NO** — gaps: Python path minOosTrades read but never enforced, validation slice computed but never read in selection, test folds pooled for promotion gating (test reused for selection), parameter IDs share "{sid}:ANY" with INSERT OR REPLACE (overwrite); TS canonical path cleaner (5-bar embargo, median-of-folds, no optimization) but train→val contiguous and no cross-fold purge.
23. Does any currently enabled strategy show positive realistic OOS expectancy? **NO**.
24. Is supervised PAPER trading safe tomorrow? **YES** — conditional on the pre-market checklist gates passing (OKTA reconciliation, budget activation, positions/orders reconciled, PAPER_TRADING_ONLY=true confirmed in deployment env, fresh-tick feed health). If any gate fails, the session must not proceed.
25. Would you personally sign an engineering release certificate for tomorrow's PAPER session based on this evidence? **NO** — the code is signed; the session cannot be signed until Monday's checklist gates (Q9, Q10, Q13, Q14, Q15, Q20) pass.

## FINAL NOTE

Profit tomorrow is not guaranteed, and no audit can prove it. This report certifies engineering readiness — defects fixed, gates armed, isolation proven, evidence honestly classified — not profitability. Edge evidence is WEAK and expected value is INSUFFICIENT_EVIDENCE; a healthy Argus tomorrow may correctly make zero trades, and that is a successful outcome.
