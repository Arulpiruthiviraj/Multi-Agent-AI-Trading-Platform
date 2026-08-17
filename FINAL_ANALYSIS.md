# Argus Autonomous Trading Platform — FINAL FORENSIC ANALYSIS & READINESS MATRIX

**Audit Date:** 2026-08-16 (evening pass — includes real runtime evidence from actually operating the system, not just static code inspection)
**Auditor role:** Principal Quantitative Systems Auditor / Lead Risk Officer / Adversarial Code Reviewer
**Verification commands, this pass:** `npx tsc --noEmit` — **PASS**, exit 0, zero errors. `npx vitest run` — **PASS**, **1091 tests / 166 files**, 0 failed.

**Overall Real-Money Readiness (deterministic weighted blend, Section 8):** **58.35%**
**Deterministic Engineering Readiness** (Software + Risk + External-Integration dimensions only): **~91%**
**True Capital Readiness** (hostile blend including empirical-edge dimensions): **58.35%** — the gap between these two numbers *is* the honest state of this project.

| Verdict | Status |
|---|---|
| LIVE Autonomous Trading | **NO-GO** |
| Supervised Paper Trading | **CONDITIONAL GO** (real, but currently self-pausing — see §7) |
| Unattended Paper Certificate | **NO-GO** |
| Empirical Trading Edge | **0/100 — `NOT_ESTABLISHED`** (0 real closed organic trades on disk; see §7) |
| Canadian Live Execution (IIROC) | **BLOCKED** (external/regulatory, not a code gap) |

This document supersedes the same-day earlier version. Everything below was either re-verified with a fresh command this pass, or is new evidence produced by actually running the system (enabling real Autobot in real PAPER mode against a real Alpaca paper account) rather than only reading source.

---

## 1. Executive Summary — The 5 Critical Gaps

1. **Zero organic closed paper trades still exist**, even after actually turning the system on. `trades`: 8 rows — 6 diagnostic artifacts (`DIAGTEST*`/`DIAGORDER*`/`DIAGCHAIN*`, all `PENDING`), 1 FILLED BUY/SELL pair tagged `REPLAY` (-$91.05, historical-replay lab, not live paper). `minPaperTrades: 30` remains 0/30.
2. **No validated statistical edge, now backed by a real, comprehensive gauntlet, not one data point.** This pass ran 25 real walk-forward + robustness evaluations (5 CORE strategies × 5 real symbols — QQQ, AAPL, NVDA, MSFT, AMD — each on ~2 years of real GREEN Alpaca daily data). **0 of 25 passed WFO. 0 of 25 passed all four robustness gates** (Monte Carlo, permutation, sensitivity, cost-stress). A material fraction of the `FRAGILE` verdicts trace to `testTrades: 0` in individual WFO folds — meaning the honest finding is partly "insufficient real trade volume to conclude anything," not uniformly "traded and lost."
3. **A real safety mechanism just proved itself, and in doing so revealed a real operational gap.** `PortfolioReconciliation.ts` correctly auto-paused live PAPER trading twice this evening against real Alpaca account state (two pre-existing GLD/NVDA positions it didn't recognize). The pause logic is correct; what's missing is a way to durably resolve a *known, accepted* discrepancy so it stops re-tripping every cycle. This is the single blocker between "infrastructure is ready" and "the 30-day soak can run unattended."
4. **Python/VectorBT parity remains feature-subset only**, and Parquet durability is blocked by a real, verified missing dependency: every one of this pass's 5 real ingests failed parquet write with `pyarrow_unavailable: No module named 'pyarrow'` — not a logic bug, an environment gap.
5. **`BacktestEngine.ts` remains `SAME_BAR_CLOSE`**, explicitly non-promotable; only `canonicalNextBarEngine.ts`'s `NEXT_BAR_OPEN` path is used for anything promotion-adjacent, and it is what this pass's real WFO gauntlet ran on.

---

## 2. Complete Subsystem Inventory

| Subsystem | Path | Real / Verified | Test coverage |
|---|---|---|---|
| Live decision spine | `server.ts`, `TechnicalAgent/ChiefTraderAgent/RiskAgent/QuantSignalAgent.ts` | Real, production | Extensive |
| Risk & sizing | `RiskEngine.ts`, `PositionSizing.ts`, `RestrictedLiveMode.ts`, `CapitalAllocation.ts`, `DailyBuyNotional.ts` | Real; **live-fire verified this pass** (real reconciliation pause, twice) | Extensive |
| Order execution | `OrderManagement.ts` + broker adapters | Real, sole `placeOrder` path | Extensive |
| Broker adapters | Alpaca / InternalPaper / IBKR / Coinbase / Questrade / HistoricalReplay | Real; Alpaca only fully unattended one | Per-adapter |
| Ecosystem orchestrator | `scripts/ecosystem-dev.ts` (now the real `npm run dev` entry point) | Real; spawns Vibe-Trading-MCP/AutoHedge/Fincept as **separate OS processes**, zero code coupling to `BrokerManager` | N/A (launcher script) |
| External research adapters | Vibe-Trading MCP (port 8900, AI keys only), AutoHedge (AI keys + forcibly-emptied `WALLET_PRIVATE_KEY`/`SOLANA_PRIVATE_KEY` + `AUTOHEDGE_PAPER_ONLY:'true'`), OpenAlice (MCP, read-only) | Real, verified this pass (`ecosystem-dev.ts:305-347`) | N/A |
| Research/backtest core | `BacktestEngine.ts` (SAME_BAR, legacy) vs `canonicalNextBarEngine.ts` (NEXT_BAR, canonical) | Real, two distinct fill models, not mixed | Extensive |
| Research validation | `coreWalkForward.ts`, `coreRobustness.ts`, `multipleTesting.ts` | Real; **just ran 25 real evaluations this pass** (§7.2) | Extensive |
| AI routing | `AIRouter.ts` + `Gemini/OpenAI/DeepSeek/Nvidia/OpenAI-compatible` providers | Real | Extensive |
| Database | `data/argus.db`, `better-sqlite3` + Drizzle WAL | Real; integrity-checked this session | N/A |
| UI (SPA) | `src/App.tsx`, `src/components/*` | Real event-bound visualizers verified; thin test coverage (documented, longstanding) | Minimal |

---

## 3. Order Path & State Machine Forensics

```
MarketDataWorker (real Alpaca WS ticks)
  -> EventBus 'MARKET_DATA' / 'MARKET_DATA_UPDATED'
  -> Agents (Technical/News/Fundamental/Macro/PortfolioMonitor/QuantSignalAgent) -> 'TRADE_IDEA_GENERATED'
  -> ChiefTraderAgent.evaluateConsensus() -> 'CHIEF_APPROVED_IDEA'
  -> RiskAgent.assessRisk() -> RiskEngine.evaluateRisk() (24-gate serialized ladder)
  -> 'RISK_ASSESSMENT_COMPLETED'
  -> OrderManagementService (sole production `placeOrder` caller)
  -> BrokerManager.getActiveBroker() -> adapter -> real order
```

**Grep proof, re-run fresh this pass:**
- `executeAutoBotTradeInSovereign`: **0 matches**, tree-wide.
- `BrokerEngine.ts`: **confirmed absent** (deleted).
- `.placeOrder(` outside `*.test.ts`: only the 5 broker adapters (internal close/flatten helpers) plus `OrderManagement.ts`. `server.ts`, every route file, and `App.tsx`: **zero**.
- Vibe-Trading/AutoHedge/Fincept/OpenAlice: **zero references anywhere under `src/`** — real, separate-process isolation, not just coding discipline.

**5-layer LIVE arm invariant** (unchanged, re-confirmed):

| Layer | Mechanism |
|---|---|
| 1. Confirmation phrase | `TradingEngine.toggle()` requires `confirmLiveTrading === 'ENABLE LIVE TRADING'` |
| 2. In-memory arm | `LiveTradingConfirmation.ts`'s `isLiveTradingArmed()` |
| 3. Dual-flag agreement | `assertBrokerEnvironmentAllowsOrder()` — `tradingMode` and `paperMode` must agree or the order outcome is `UNKNOWN` |
| 4. Live-Alpaca-host refusal | `AlpacaBroker.placeOrder` refuses `api.alpaca.markets` without the arm |
| 5. Restart clearance | The arm is in-memory only; a process restart clears it even if SQLite still says LIVE |

**New this pass:** `npm run dev` now resolves to `scripts/ecosystem-dev.ts`, not the previously-documented `devWithOpenAlice.ts` directly — `CLAUDE.md` already reflects this correctly (lines 32-41; an earlier same-day pass of this document incorrectly flagged this as undocumented drift and that claim is retracted here).

---

## 4. RiskEngine 24-Gate Deep Audit

Unchanged from the prior pass (no source changes to `RiskEngine.ts`/`PositionSizing.ts` since), re-confirmed fresh this pass by direct file read. Full 24-gate table with file:line citations lives in this document's revision history; the load-bearing facts:

- All 24 gates (per `config/riskGateOrder.json`) evaluate **unconditionally** every time — a rejected proposal still gets a complete gate-by-gate record.
- **Sizing honesty** (`PositionSizing.ts:239-256`): confirmed present — if `maxQuantity === 0`, any gate still reporting `passed:true` with a `CLAMPED` status and `boundQuantity === 0` is walked back and flipped to `passed:false, status:'FAIL'`. A binding clamp can never show a pass at zero shares.
- **Fail-closed gates re-confirmed:** `invalid_account_equity` (no placeholder balance), `data_freshness` (`priceAgeMs===null` → `UNKNOWN`, never fresh), `market_hours` (HTTP/network failure → `unavailable`, never treated as open — **this is the exact gate that correctly blocked Phase A2's closing orders this pass, since real market hours are closed on a Sunday evening**).

---

## 5. Ecosystem & Research Integration Architecture

```
                     ┌─────────────────────────────┐
                     │   scripts/ecosystem-dev.ts   │   (npm run dev entry point)
                     └──────────────┬──────────────┘
              ┌──────────────────────┼───────────────────────┐
              │                      │                        │
    ┌─────────▼─────────┐  ┌─────────▼──────────┐   ┌─────────▼─────────┐
    │ Vibe-Trading-MCP   │  │     AutoHedge       │   │  FinceptTerminal   │
    │ separate process   │  │  separate process   │   │  (disabled here;   │
    │ port 8900          │  │  WALLET_PRIVATE_KEY │   │   dir absent)      │
    │ env: AI keys ONLY  │  │    = "" (forced)    │   └────────────────────┘
    │ zero BrokerManager │  │  SOLANA_PRIVATE_KEY │
    │ import              │  │    = "" (forced)    │
    └────────────────────┘  │  AUTOHEDGE_PAPER_   │
                             │  ONLY = 'true'       │
                             └──────────────────────┘
                                        │
                          (no code-level path back into
                           Argus's BrokerManager/OMS —
                           verified by exhaustive grep, §3)
                     ┌──────────────────▼──────────────────┐
                     │        tsx server.ts (Argus core)     │
                     │  Sacred fill path, §3                 │
                     └────────────────────────────────────────┘
```

**Security invariants, verified directly in `scripts/ecosystem-dev.ts` this pass:**
- Vibe-Trading-MCP (`:305-327`): spawned only if `ENABLE_VIBE_TRADING_MCP=true`; `env` passed is exactly `{OPENAI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, NVIDIA_API_KEY, GROQ_API_KEY, GEMINI_API_KEY}` — **no Alpaca/broker credentials of any kind**.
- AutoHedge (`:330-347`): `WALLET_PRIVATE_KEY: ''` and `SOLANA_PRIVATE_KEY: ''` are hardcoded empty strings in the spawn config itself (not merely unset), plus an explicit `AUTOHEDGE_PAPER_ONLY: 'true'` flag — three independent layers preventing real fund movement even if AutoHedge itself is natively capable of it.
- `process.on('SIGINT', ...)` and `process.on('SIGTERM', ...)` (`:115-120`) both call `killTracked()`, which terminates every tracked child PID (`taskkill /T` on Windows per the code's own comment) — no orphaned companion processes on shutdown.
- In this environment specifically: `vibe-trading` and `autohedge` sibling directories exist on disk and are enabled in `.env`; `FinceptTerminal` is disabled and its directory doesn't exist. None of the three were actually running as processes during this session (server was started via `dev:server-only`).

---

## 6. Research Engine & Warehouse Parity

| Item | Status | Evidence |
|---|---|---|
| `BacktestEngine.ts` fill model | `SAME_BAR_CLOSE`, explicitly `promotable:false` | File header, unchanged |
| `canonicalNextBarEngine.ts` | `NEXT_BAR_OPEN` only; this pass's real 25-run gauntlet used this engine exclusively | Confirmed via `runCoreWalkForward`'s own output: `"executionModel": "NEXT_BAR_OPEN", "comparableToSameBarClose": false` |
| CORE feature-vector parity | `FEATURE_SUBSET_PARITY` (BOS/RVOL/Keltner/S-R only) | Unchanged |
| Full `StrategyContext.evaluate()` Python parity | Not established | Unchanged |
| Parquet durability | **0 files physically written**, real cause identified this pass | All 5 real ingests this session failed identically: `pyarrow_unavailable: No module named 'pyarrow'` — a missing Python package, not a code defect |
| GREEN datasets on disk | Now **6** (was 1) | This pass ingested real, GREEN-graded Alpaca daily data for QQQ, AAPL, NVDA, MSFT, AMD (519 bars each, ~2 years), alongside the pre-existing SPY dataset |

---

## 7. Empirical Evidence — Database & the Real Gauntlet

### 7.1 Database state (`data/argus.db`, this pass)

```
trades: 8 rows — 6x DIAGTEST*/DIAGORDER*/DIAGCHAIN* (PENDING, diagnostic artifacts)
         1x AAPL BUY  FILLED, execution_environment=REPLAY
         1x AAPL SELL FILLED, execution_environment=REPLAY, profit_loss=-91.05
transactions: 419 NO_CONSENSUS, 243 RISK_REJECTED, 40 OPEN (pre-dates a same-day restart fix; not an active bug)
fills: 2 (both from the same REPLAY pair)
```
Organic closed paper trades (per `organicPaper.ts:isOrganicClosedPaper()` — `FILLED`+`SELL`+real `profitLoss`+`classifyTradeEnvironment()==='PAPER'`+not a manual override): **0**. `minPaperTrades: 30` — **0/30**.

### 7.2 The real WFO gauntlet (new this pass)

Actually ran, end to end, for the first time: real Alpaca ingestion → real GREEN grading → real `NEXT_BAR_OPEN` walk-forward → real robustness (Monte Carlo, permutation, sensitivity, cost-stress) — for all 5 CORE strategies against 5 real symbols (25 total evaluations).

| Result | Count |
|---|---|
| Total real strategy × symbol evaluations | 25 |
| WFO verdict `FRAGILE` | 25 / 25 |
| WFO verdict passing (`ROBUST`/`PASS`) | 0 / 25 |
| All 4 robustness gates passing simultaneously | 0 / 25 |
| Individual robustness gates passing at least once | `sensitivityPass` and `costStressPass` passed on a handful of PULLBACK_CONTINUATION/TREND_FOLLOWING/RANGE_REVERSION combos; `monteCarloPass`/`permutationPass` almost never |

**Honest caveat, visible in the raw fold data:** several WFO folds report `testTrades: 0` — the 5 CORE strategies are selective enough that a single ~2-year, single-symbol window often doesn't produce enough real entries per fold to compute a median expectancy at all (`medianTestExpectancy: null`). Part of this result is "no real edge demonstrated," and part of it is honestly "insufficient real sample size to demonstrate anything, positive or negative" — both are real findings, and they are not the same claim.

### 7.3 Real-world safety mechanism validation (new this pass — the most important operational finding)

Autobot was actually enabled in real PAPER mode against the real Alpaca paper account this session. Two real, consequential things happened:

1. `PortfolioReconciliation.ts` detected 2 real pre-existing positions (1 GLD, 1 NVDA) that predate Argus's own order tracking, correctly flagged a ~$401.48 mismatch, and auto-paused trading (`kill_switch_events` id 8, `action_taken: TRADING_PAUSED`) — exactly as designed.
2. After a manual review and resume, it paused **again** 5 minutes later (`kill_switch_events`, ~$387.97 mismatch). Root-caused this pass: `PortfolioReconciliation.ts:162-165` diffs every Alpaca `FILLED` order against `trades.brokerOrderId` — these two positions' original fills predate Argus's tracking, so they have **no local order row and never will** without intervention. **This will re-trigger on every future reconciliation cycle**, not just once. The mechanism is correct; the underlying account state has never been durably reconciled.

Remediation requires an explicit choice between backfilling real historical trade records, closing the positions via a real order (blocked right now only by real market hours — see §9), or changing the reconciliation logic to durably accept a known/reviewed discrepancy. This is deliberately not resolved unilaterally in this document — see roadmap.

---

## 8. Weighted Real-Money Readiness Scorecard

$$\text{Readiness} = \sum (\text{Dimension Score} \times \text{Weight})$$

| # | Dimension | Weight | Score | Contribution | Evidence |
|---|---|:---:|:---:|:---:|---|
| 1 | Software & Compiler Infrastructure | 20% | 90 | 18.0 | `tsc` clean, 166/1091 tests passing, re-verified twice this pass |
| 2 | Risk & Safety Controls | 25% | 93 | 23.25 | 24-gate ladder + sizing honesty unchanged; **live-fire verified** this pass (real reconciliation pause, twice) |
| 3 | External Research Integration | 10% | 95 | 9.5 | Zero code coupling, wallet keys forcibly emptied, SIGINT/SIGTERM cleanup confirmed, all directly re-verified this pass |
| 4 | Data Warehouse & Parity | 20% | 40 | 8.0 | 6 real GREEN datasets now (was 1); Parquet still 0 files (real, identified `pyarrow` gap); feature-subset-only Python parity unchanged. Slightly up from the prior 38% given the real 6x expansion in GREEN coverage |
| 5 | Empirical Edge & Organic Soak | 25% | 0 | 0.0 | 0/30 organic paper trades; **25/25 real WFO evaluations FRAGILE**, 0/25 robustness passes — now backed by a comprehensive real gauntlet, not a single data point |
| **Total** | | **100%** | — | **58.75%** | |

*(Note: this recomputation shows 58.75%, marginally above the same-day earlier 58.35%, driven entirely by dimension 4's real expansion from 1 to 6 GREEN datasets — not by any change in the empirical-edge finding, which remains at its floor.)*

**Why the gap between 91% engineering and 58.75% blended readiness matters:** this pass produced the clearest demonstration yet of that gap being real, not theoretical. The same risk engine that is professionally engineered enough to correctly self-pause on a real, live reconciliation mismatch is the same reason the empirical-edge number cannot be inflated by simply "letting the bot run" — it keeps correctly refusing to manufacture activity.

---

## 9. Actionable Phase-by-Phase Roadmap

**Engineering (code) phases — no calendar dependency:**

- **Phase A** (blocking): resolve the GLD/NVDA reconciliation loop. Three real options with real tradeoffs (backfill / close positions / change reconciliation logic) — needs an explicit choice, not a unilateral fix, since one path touches safety-relevant code and another places a real order.
- **Phase D**: documentation — already current; no action needed (correction of an earlier same-day false claim).
- **Parquet dependency**: install `pyarrow` in the Python research environment to unblock durable warehouse writes — a real, bounded, low-risk environment change, distinct from any TypeScript code fix.

**Operational / incubation phases — real calendar time, cannot be accelerated:**

- **Phase A2 / market-dependent close**: blocked until real market hours resume (next NYSE session) — Argus's own `market_hours` gate correctly refuses to submit orders while the market is closed, including this remediation's own closing orders.
- **Phase C (30-day organic soak)**: infrastructure-ready today; blocked only on Phase A. Once running cleanly, still requires multiple real weeks to accumulate 30 closed organic trades — nothing in this pass changes that arithmetic.
- **Phase 34 (manual live arming)**: explicitly out of scope for any automated process, this session or any other — requires a human reviewing real accumulated evidence that does not yet exist.

Do not enable LIVE. Do not count the 25-evaluation WFO gauntlet, the historical-replay trade, the shadow ledger, or any external research adapter's output as organic paper evidence or a validated edge. The 58.75% readiness figure describes engineering maturity blended honestly with trading validation — it is not, and must never be read as, a probability of profit.
